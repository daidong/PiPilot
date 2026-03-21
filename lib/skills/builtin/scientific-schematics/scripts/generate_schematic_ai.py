#!/usr/bin/env python3
"""
AI-powered scientific schematic generation using Vertex AI image models.

This script uses a smart iterative refinement approach:
1. Generate initial image with Vertex AI
2. AI quality review using Gemini for scientific critique
3. Only regenerate if quality is below threshold for document type
4. Repeat until quality meets standards (max iterations)

Requirements:
    - GOOGLE_CLOUD_PROJECT environment variable or gcloud project config
    - Vertex AI access via GKE Workload Identity, metadata server, or gcloud auth
    - requests library

Usage:
    python generate_schematic_ai.py "Create a flowchart showing CONSORT participant flow" -o flowchart.png
    python generate_schematic_ai.py "Neural network architecture diagram" -o architecture.png --iterations 2
    python generate_schematic_ai.py "Simple block diagram" -o diagram.png --doc-type poster
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError:
    print("Error: requests library not found. Install with: pip install requests")
    sys.exit(1)


# Try to load .env file from multiple potential locations
def _load_env_file():
    """Load .env file from current directory, parent directories, or package directory.

    Returns True if a .env file was found and loaded, False otherwise.
    Note: This does NOT override existing environment variables.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:
        return False  # python-dotenv not installed

    # Try current working directory first
    env_path = Path.cwd() / ".env"
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)
        return True

    # Try parent directories (up to 5 levels)
    cwd = Path.cwd()
    for _ in range(5):
        env_path = cwd / ".env"
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=False)
            return True
        cwd = cwd.parent
        if cwd == cwd.parent:  # Reached root
            break

    # Try the package's parent directory (scientific-writer project root)
    script_dir = Path(__file__).resolve().parent
    for _ in range(5):
        env_path = script_dir / ".env"
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=False)
            return True
        script_dir = script_dir.parent
        if script_dir == script_dir.parent:
            break

    return False


class ScientificSchematicGenerator:
    """Generate scientific schematics using AI with smart iterative refinement.

    Uses Gemini review to determine if regeneration is needed.
    Multiple passes only occur if the generated schematic doesn't meet the
    quality threshold for the target document type.
    """

    # Quality thresholds by document type (score out of 10)
    # Higher thresholds for more formal publications
    QUALITY_THRESHOLDS = {
        "journal": 8.5,  # Nature, Science, etc. - highest standards
        "conference": 8.0,  # Conference papers - high standards
        "poster": 7.0,  # Academic posters - good quality
        "presentation": 6.5,  # Slides/talks - clear but less formal
        "report": 7.5,  # Technical reports - professional
        "grant": 8.0,  # Grant proposals - must be compelling
        "thesis": 8.0,  # Dissertations - formal academic
        "preprint": 7.5,  # arXiv, etc. - good quality
        "default": 7.5,  # Default threshold
    }

    GEMINI_IMAGE_MODELS = (
        "gemini-3-pro-image-preview",
    )
    IMAGEN_IMAGE_MODELS = (
        "imagen-4.0-generate-001",
        "imagen-4.0-fast-generate-001",
    )
    SUPPORTED_IMAGE_MODELS = GEMINI_IMAGE_MODELS + IMAGEN_IMAGE_MODELS
    SUPPORTED_REVIEW_MODELS = (
        "gemini-3.1-pro-preview",
        "gemini-3-pro-preview",
        "gemini-3-flash-preview",
    )
    DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview"
    DEFAULT_REVIEW_MODEL = "gemini-3.1-pro-preview"
    DEFAULT_VERTEX_LOCATION = "global"
    DEFAULT_IMAGEN_LOCATION = "us-central1"
    DEFAULT_REQUEST_TIMEOUT_SECONDS = 300

    # Scientific diagram best practices prompt template
    SCIENTIFIC_DIAGRAM_GUIDELINES = """
Create a high-quality scientific diagram with these requirements:

VISUAL QUALITY:
- Clean white or light background (no textures or gradients). Professional pastel tones.
- Flat vector illustration, academic aesthetic. Similar to figures in DeepMind or OpenAI papers.
- High contrast for readability and printing
- Professional, publication-ready appearance
- Sharp, clear lines and text
- Adequate spacing between elements to prevent crowding

TYPOGRAPHY:
- Clear, readable sans-serif fonts (Arial, Helvetica style)
- Minimum 10pt font size for all labels
- Consistent font sizes throughout
- All text horizontal or clearly readable
- No overlapping text

SCIENTIFIC STANDARDS:
- Accurate representation of concepts
- Clear labels for all components
- Include scale bars, legends, or axes where appropriate
- Use standard scientific notation and symbols
- Include units where applicable

ACCESSIBILITY:
- Colorblind-friendly color palette (use Okabe-Ito colors if using color)
- High contrast between elements
- Redundant encoding (shapes + colors, not just colors)
- Works well in grayscale

LAYOUT:
- Logical flow (left-to-right, top-to-bottom, circular and other shapes). Group related components logically.
- Clear visual hierarchy
- Balanced composition
- Appropriate use of whitespace
- No clutter or unnecessary decorative elements

IMPORTANT - NO FIGURE NUMBERS:
- Do NOT include "Figure 1:", "Fig. 1", or any figure numbering in the image
- Do NOT add captions or titles like "Figure: ..." at the top or bottom
- Figure numbers and captions are added separately in the document/LaTeX
- The diagram should contain only the visual content itself

Negative Constraints:
- NO photorealistic photos, NO messy sketches, NO unreadable text, NO 3D shading artifacts.
"""

    def __init__(
        self,
        access_token: Optional[str] = None,
        project: Optional[str] = None,
        location: Optional[str] = None,
        image_model: Optional[str] = None,
        image_location: Optional[str] = None,
        review_model: Optional[str] = None,
        request_timeout_seconds: Optional[int] = None,
        verbose: bool = False,
    ):
        """
        Initialize the generator.

        Args:
            access_token: Optional OAuth access token for Vertex AI
            project: Google Cloud project ID
            location: Vertex AI location (defaults to global)
            image_model: Vertex image generation model ID
            image_location: Optional Vertex location override for image generation
            review_model: Vertex review model ID
            request_timeout_seconds: Request timeout for Vertex API calls
            verbose: Print detailed progress information
        """
        _load_env_file()
        self.verbose = verbose
        self._last_error = None  # Track last error for better reporting
        self.project = (
            project
            or os.getenv("GOOGLE_CLOUD_PROJECT")
            or os.getenv("GCLOUD_PROJECT")
            or self._run_command(["gcloud", "config", "get-value", "project"])
        )
        self.location = (
            location
            or os.getenv("GOOGLE_CLOUD_LOCATION")
            or os.getenv("VERTEX_AI_LOCATION")
            or self.DEFAULT_VERTEX_LOCATION
        )
        if not self.project:
            raise ValueError(
                "GOOGLE_CLOUD_PROJECT is not set and no gcloud project could be discovered.\n"
                "Set GOOGLE_CLOUD_PROJECT or run `gcloud config set project <PROJECT_ID>`."
            )

        # Gemini 3 Pro Image is Nano Banana Pro on Vertex AI.
        self.image_model = (
            image_model
            or os.getenv("SCHEMATIC_IMAGE_MODEL")
            or self.DEFAULT_IMAGE_MODEL
        )
        self.review_model = (
            review_model
            or os.getenv("SCHEMATIC_REVIEW_MODEL")
            or self.DEFAULT_REVIEW_MODEL
        )
        self.image_location = (
            image_location
            or os.getenv("GOOGLE_CLOUD_IMAGE_LOCATION")
            or os.getenv("SCHEMATIC_IMAGE_LOCATION")
            or (
                self.DEFAULT_IMAGEN_LOCATION
                if self._is_imagen_model(self.image_model)
                else self.location
            )
        )
        self.request_timeout_seconds = self._parse_timeout_seconds(
            request_timeout_seconds
            or os.getenv("SCHEMATIC_REQUEST_TIMEOUT_SECONDS")
            or os.getenv("VERTEX_REQUEST_TIMEOUT_SECONDS")
        )
        self._access_token = (
            access_token
            or os.getenv("VERTEX_ACCESS_TOKEN")
            or os.getenv("GOOGLE_OAUTH_ACCESS_TOKEN")
        )
        self._token_expiry_epoch = 0.0

    def _parse_timeout_seconds(self, value: Optional[Any]) -> int:
        try:
            parsed = int(str(value).strip()) if value is not None else 0
        except (TypeError, ValueError):
            parsed = 0
        return max(parsed, 30) if parsed else self.DEFAULT_REQUEST_TIMEOUT_SECONDS

    def _is_imagen_model(self, model: str) -> bool:
        return model in self.IMAGEN_IMAGE_MODELS or model.startswith("imagen-")

    def _log(self, message: str):
        """Log message if verbose mode is enabled."""
        if self.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {message}")

    def _run_command(self, command: List[str]) -> str:
        try:
            result = subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            return ""
        return result.stdout.strip()

    def _fetch_metadata_access_token(self) -> Tuple[str, float]:
        response = requests.get(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            headers={"Metadata-Flavor": "Google"},
            timeout=2,
        )
        response.raise_for_status()
        payload = response.json()
        token = str(payload.get("access_token", "")).strip()
        expires_in = int(payload.get("expires_in", 0) or 0)
        return token, time.time() + max(expires_in - 60, 0)

    def _get_access_token(self) -> str:
        if self._access_token and time.time() < self._token_expiry_epoch:
            return self._access_token
        if self._access_token and self._token_expiry_epoch == 0:
            return self._access_token

        try:
            token, expiry = self._fetch_metadata_access_token()
            if token:
                self._access_token = token
                self._token_expiry_epoch = expiry
                return token
        except requests.exceptions.RequestException:
            pass

        for command in (
            ["gcloud", "auth", "application-default", "print-access-token"],
            ["gcloud", "auth", "print-access-token"],
        ):
            token = self._run_command(command)
            if token:
                self._access_token = token
                self._token_expiry_epoch = time.time() + 300
                return token

        raise ValueError(
            "Could not acquire a Vertex AI access token.\n"
            "Use GKE Workload Identity, run `gcloud auth application-default login`, "
            "or pass --access-token / VERTEX_ACCESS_TOKEN."
        )

    def _to_vertex_contents(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        contents: List[Dict[str, Any]] = []
        for message in messages:
            role = str(message.get("role", "user")).lower()
            vertex_role = "USER" if role != "assistant" else "MODEL"
            content = message.get("content", "")
            parts: List[Dict[str, Any]] = []
            if isinstance(content, str):
                if content.strip():
                    parts.append({"text": content})
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type")
                    if block_type == "text":
                        text = str(block.get("text", "")).strip()
                        if text:
                            parts.append({"text": text})
                    elif block_type == "image_url":
                        image_url = block.get("image_url", {})
                        url = image_url.get("url", "") if isinstance(image_url, dict) else image_url
                        if isinstance(url, str) and url.startswith("data:") and "," in url:
                            header, data = url.split(",", 1)
                            mime_match = re.match(r"data:([^;]+);base64$", header)
                            mime_type = mime_match.group(1) if mime_match else "image/png"
                            parts.append({
                                "inlineData": {
                                    "mimeType": mime_type,
                                    "data": data,
                                }
                            })
            if parts:
                contents.append({"role": vertex_role, "parts": parts})
        return contents

    def _post_json(
        self,
        url: str,
        payload: Dict[str, Any],
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        timeout = timeout_seconds or self.request_timeout_seconds
        headers = {
            "Authorization": f"Bearer {self._get_access_token()}",
            "Content-Type": "application/json",
        }
        try:
            response = requests.post(
                url,
                headers=headers,
                json=payload,
                timeout=timeout,
            )

            try:
                response_json = response.json()
            except json.JSONDecodeError:
                response_json = {"raw_text": response.text[:500]}

            if response.status_code != 200:
                error_detail = response_json.get("error", response_json)
                self._log(f"HTTP {response.status_code}: {error_detail}")
                raise RuntimeError(
                    f"API request failed (HTTP {response.status_code}): {error_detail}"
                )

            return response_json
        except requests.exceptions.Timeout:
            raise RuntimeError(f"API request timed out after {timeout} seconds")
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"API request failed: {str(e)}")

    def _make_request(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        modalities: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Make a request to Vertex AI generateContent.

        Args:
            model: Model identifier
            messages: List of message dictionaries
            modalities: Optional list of modalities (e.g., ["image", "text"])

        Returns:
            API response as dictionary
        """
        payload: Dict[str, Any] = {
            "contents": self._to_vertex_contents(messages),
        }
        if modalities:
            payload["generationConfig"] = {
                "responseModalities": [str(modality).upper() for modality in modalities],
                "candidateCount": 1,
            }
            if "IMAGE" in payload["generationConfig"]["responseModalities"]:
                payload["generationConfig"]["imageConfig"] = {"aspectRatio": "4:3"}

        self._log(f"Making generateContent request to {model} in {self.location}...")
        return self._post_json(
            f"https://aiplatform.googleapis.com/v1/projects/{self.project}/locations/{self.location}/publishers/google/models/{model}:generateContent",
            payload,
        )

    def _make_imagen_request(self, prompt: str) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "instances": [
                {
                    "prompt": prompt,
                }
            ],
            "parameters": {
                "sampleCount": 1,
                "aspectRatio": "4:3",
                "addWatermark": False,
            },
        }
        self._log(f"Making Imagen predict request to {self.image_model} in {self.image_location}...")
        return self._post_json(
            f"https://aiplatform.googleapis.com/v1/projects/{self.project}/locations/{self.image_location}/publishers/google/models/{self.image_model}:predict",
            payload,
        )

    def _extract_image_from_response(self, response: Dict[str, Any]) -> Optional[bytes]:
        """
        Extract image bytes from a Vertex AI generateContent response.

        Args:
            response: API response dictionary

        Returns:
            Image bytes or None if not found
        """
        try:
            candidates = response.get("candidates", [])
            if not candidates:
                self._log("No candidates in response")
                return None

            content = candidates[0].get("content", {})
            parts = content.get("parts", []) if isinstance(content, dict) else []
            for index, part in enumerate(parts):
                if not isinstance(part, dict):
                    continue
                inline_data = part.get("inlineData", {})
                if isinstance(inline_data, dict) and inline_data.get("data"):
                    data = str(inline_data["data"]).replace("\n", "").replace("\r", "").replace(" ", "")
                    self._log(f"Found image in candidate part {index}")
                    return base64.b64decode(data)

            self._log("No image data found in response")
            return None

        except Exception as e:
            self._log(f"Error extracting image: {str(e)}")
            import traceback

            if self.verbose:
                traceback.print_exc()
            return None

    def _extract_imagen_image_from_response(
        self, response: Dict[str, Any]
    ) -> Optional[bytes]:
        try:
            predictions = response.get("predictions", [])
            if not predictions:
                self._log("No predictions in Imagen response")
                return None

            first_prediction = predictions[0]
            if isinstance(first_prediction, dict) and first_prediction.get(
                "bytesBase64Encoded"
            ):
                self._log("Found image in Imagen response payload")
                return base64.b64decode(
                    str(first_prediction["bytesBase64Encoded"])
                    .replace("\n", "")
                    .replace("\r", "")
                    .replace(" ", "")
                )

            self._log("No image bytes in Imagen response")
            return None
        except Exception as e:
            self._log(f"Error extracting Imagen image: {str(e)}")
            if self.verbose:
                import traceback

                traceback.print_exc()
            return None

    def _image_to_base64(self, image_path: str) -> Tuple[str, str]:
        """
        Convert image file to a MIME type plus base64 payload.

        Args:
            image_path: Path to image file

        Returns:
            Base64 string
        """
        with open(image_path, "rb") as f:
            image_data = f.read()

        # Determine image type from extension
        ext = Path(image_path).suffix.lower()
        mime_type = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }.get(ext, "image/png")

        return mime_type, base64.b64encode(image_data).decode("utf-8")

    def generate_image(self, prompt: str) -> Optional[bytes]:
        """
        Generate an image using a Vertex AI image model.

        Args:
            prompt: Description of the diagram to generate

        Returns:
            Image bytes or None if generation failed
        """
        self._last_error = None  # Reset error

        try:
            if self._is_imagen_model(self.image_model):
                response = self._make_imagen_request(prompt)
                image_data = self._extract_imagen_image_from_response(response)
            else:
                messages = [{"role": "user", "content": prompt}]
                response = self._make_request(
                    model=self.image_model,
                    messages=messages,
                    modalities=["image", "text"],
                )
                image_data = self._extract_image_from_response(response)

            # Debug: print response structure if verbose
            if self.verbose:
                self._log(f"Response keys: {response.keys()}")
                if "error" in response:
                    self._log(f"API Error: {response['error']}")
                if "candidates" in response and response["candidates"]:
                    candidate = response["candidates"][0]
                    content = candidate.get("content", {})
                    parts = content.get("parts", []) if isinstance(content, dict) else []
                    self._log(f"Candidate part count: {len(parts)}")
                    for index, part in enumerate(parts[:3]):
                        if isinstance(part, dict):
                            self._log(f"  Part {index}: keys={list(part.keys())}")
                if "predictions" in response and response["predictions"]:
                    prediction = response["predictions"][0]
                    if isinstance(prediction, dict):
                        self._log(f"Prediction keys: {list(prediction.keys())}")

            # Check for API errors in response
            if "error" in response:
                error_msg = response["error"]
                if isinstance(error_msg, dict):
                    error_msg = error_msg.get("message", str(error_msg))
                self._last_error = f"API Error: {error_msg}"
                print(f"✗ {self._last_error}")
                return None

            if image_data:
                self._log(f"✓ Generated image ({len(image_data)} bytes)")
            else:
                self._last_error = (
                    f"No image data in Vertex response for model {self.image_model}"
                )
                self._log(f"✗ {self._last_error}")

            return image_data
        except RuntimeError as e:
            self._last_error = str(e)
            self._log(f"✗ Generation failed: {self._last_error}")
            return None
        except Exception as e:
            self._last_error = f"Unexpected error: {str(e)}"
            self._log(f"✗ Generation failed: {self._last_error}")
            import traceback

            if self.verbose:
                traceback.print_exc()
            return None

    def review_image(
        self,
        image_path: str,
        original_prompt: str,
        iteration: int,
        doc_type: str = "default",
        max_iterations: int = 2,
    ) -> Tuple[str, float, bool]:
        """
        Review generated image using Gemini for quality analysis.

        Uses Gemini's multimodal reasoning capabilities to
        evaluate the schematic quality and determine if regeneration is needed.

        Args:
            image_path: Path to the generated image
            original_prompt: Original user prompt
            iteration: Current iteration number
            doc_type: Document type (journal, poster, presentation, etc.)
            max_iterations: Maximum iterations allowed

        Returns:
            Tuple of (critique text, quality score 0-10, needs_improvement bool)
        """
        # Use Gemini 3.1 Pro for review - strong multimodal reasoning on Vertex AI
        mime_type, image_data = self._image_to_base64(image_path)

        # Get quality threshold for this document type
        threshold = self.QUALITY_THRESHOLDS.get(
            doc_type.lower(), self.QUALITY_THRESHOLDS["default"]
        )

        review_prompt = f"""You are an expert reviewer evaluating a scientific diagram for publication quality.

ORIGINAL REQUEST: {original_prompt}

DOCUMENT TYPE: {doc_type} (quality threshold: {threshold}/10)
ITERATION: {iteration}/{max_iterations}

Carefully evaluate this diagram on these criteria:

1. **Scientific Accuracy** (0-2 points)
   - Correct representation of concepts
   - Proper notation and symbols
   - Accurate relationships shown

2. **Clarity and Readability** (0-2 points)
   - Easy to understand at a glance
   - Clear visual hierarchy
   - No ambiguous elements

3. **Label Quality** (0-2 points)
   - All important elements labeled
   - Labels are readable (appropriate font size)
   - Consistent labeling style

4. **Layout and Composition** (0-2 points)
   - Logical flow (top-to-bottom or left-to-right)
   - Balanced use of space
   - No overlapping elements

5. **Professional Appearance** (0-2 points)
   - Publication-ready quality
   - Clean, crisp lines and shapes
   - Appropriate colors/contrast

RESPOND IN THIS EXACT FORMAT:
SCORE: [total score 0-10]

STRENGTHS:
- [strength 1]
- [strength 2]

ISSUES:
- [issue 1 if any]
- [issue 2 if any]

VERDICT: [ACCEPTABLE or NEEDS_IMPROVEMENT]

If score >= {threshold}, the diagram is ACCEPTABLE for {doc_type} publication.
If score < {threshold}, mark as NEEDS_IMPROVEMENT with specific suggestions."""

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": review_prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{image_data}"},
                    },
                ],
            }
        ]

        try:
            # Use Gemini for high-quality review
            response = self._make_request(model=self.review_model, messages=messages)

            candidates = response.get("candidates", [])
            if not candidates:
                # Keep return shape consistent: (critique, score, needs_improvement)
                return "Image generated successfully", 8.0, False

            content = candidates[0].get("content", {})
            parts = content.get("parts", []) if isinstance(content, dict) else []
            text_parts = []
            for block in parts:
                if isinstance(block, dict) and block.get("text"):
                    text_parts.append(str(block.get("text")))
            content = "\n".join(text_parts)

            # Try to extract score
            score = 7.5  # Default score if extraction fails

            # Look for SCORE: X or SCORE: X/10 format
            score_match = re.search(r"SCORE:\s*(\d+(?:\.\d+)?)", content, re.IGNORECASE)
            if score_match:
                score = float(score_match.group(1))
            else:
                # Fallback: look for any score pattern
                score_match = re.search(
                    r"(?:score|rating|quality)[:\s]+(\d+(?:\.\d+)?)\s*(?:/\s*10)?",
                    content,
                    re.IGNORECASE,
                )
                if score_match:
                    score = float(score_match.group(1))

            # Determine if improvement is needed based on verdict or score
            needs_improvement = False
            if "NEEDS_IMPROVEMENT" in content.upper():
                needs_improvement = True
            elif score < threshold:
                needs_improvement = True

            self._log(
                f"✓ Review complete (Score: {score}/10, Threshold: {threshold}/10)"
            )
            self._log(
                f"  Verdict: {'Needs improvement' if needs_improvement else 'Acceptable'}"
            )

            return (
                content if content else "Image generated successfully",
                score,
                needs_improvement,
            )
        except Exception as e:
            self._log(f"Review skipped: {str(e)}")
            # Don't fail the whole process if review fails - assume acceptable
            return "Image generated successfully (review skipped)", 7.5, False

    def improve_prompt(
        self, original_prompt: str, critique: str, iteration: int
    ) -> str:
        """
        Improve the generation prompt based on critique.

        Args:
            original_prompt: Original user prompt
            critique: Review critique from previous iteration
            iteration: Current iteration number

        Returns:
            Improved prompt for next generation
        """
        improved_prompt = f"""{self.SCIENTIFIC_DIAGRAM_GUIDELINES}

USER REQUEST: {original_prompt}

ITERATION {iteration}: Based on previous feedback, address these specific improvements:
{critique}

Generate an improved version that addresses all the critique points while maintaining scientific accuracy and professional quality."""

        return improved_prompt

    def generate_iterative(
        self,
        user_prompt: str,
        output_path: str,
        iterations: int = 2,
        doc_type: str = "default",
    ) -> Dict[str, Any]:
        """
        Generate scientific schematic with smart iterative refinement.

        Only regenerates if the quality score is below the threshold for the
        specified document type. This saves API calls and time when the first
        generation is already good enough.

        Args:
            user_prompt: User's description of desired diagram
            output_path: Path to save final image
            iterations: Maximum refinement iterations (default: 2, max: 2)
            doc_type: Document type for quality threshold (journal, poster, etc.)

        Returns:
            Dictionary with generation results and metadata
        """
        output_path = Path(output_path)
        output_dir = output_path.parent
        output_dir.mkdir(parents=True, exist_ok=True)

        base_name = output_path.stem
        extension = output_path.suffix or ".png"

        # Get quality threshold for this document type
        threshold = self.QUALITY_THRESHOLDS.get(
            doc_type.lower(), self.QUALITY_THRESHOLDS["default"]
        )

        results = {
            "user_prompt": user_prompt,
            "doc_type": doc_type,
            "quality_threshold": threshold,
            "iterations": [],
            "final_image": None,
            "final_score": 0.0,
            "success": False,
            "early_stop": False,
            "early_stop_reason": None,
        }

        current_prompt = f"""{self.SCIENTIFIC_DIAGRAM_GUIDELINES}

USER REQUEST: {user_prompt}

Generate a publication-quality scientific diagram that meets all the guidelines above."""

        print(f"\n{'=' * 60}")
        print(f"Generating Scientific Schematic")
        print(f"{'=' * 60}")
        print(f"Description: {user_prompt}")
        print(f"Document Type: {doc_type}")
        print(f"Quality Threshold: {threshold}/10")
        print(f"Max Iterations: {iterations}")
        print(f"Output: {output_path}")
        print(f"{'=' * 60}\n")

        for i in range(1, iterations + 1):
            print(f"\n[Iteration {i}/{iterations}]")
            print("-" * 40)

            # Generate image
            print(f"Generating image...")
            image_data = self.generate_image(current_prompt)

            if not image_data:
                error_msg = getattr(
                    self,
                    "_last_error",
                    "Image generation failed - no image data returned",
                )
                print(f"✗ Generation failed: {error_msg}")
                results["iterations"].append(
                    {"iteration": i, "success": False, "error": error_msg}
                )
                continue

            # Save iteration image
            iter_path = output_dir / f"{base_name}_v{i}{extension}"
            with open(iter_path, "wb") as f:
                f.write(image_data)
            print(f"✓ Saved: {iter_path}")

            # Review image using Gemini
            print(f"Reviewing image with Gemini...")
            critique, score, needs_improvement = self.review_image(
                str(iter_path), user_prompt, i, doc_type, iterations
            )
            print(f"✓ Score: {score}/10 (threshold: {threshold}/10)")

            # Save iteration results
            iteration_result = {
                "iteration": i,
                "image_path": str(iter_path),
                "prompt": current_prompt,
                "critique": critique,
                "score": score,
                "needs_improvement": needs_improvement,
                "success": True,
            }
            results["iterations"].append(iteration_result)

            # Check if quality is acceptable - STOP EARLY if so
            if not needs_improvement:
                print(
                    f"\n✓ Quality meets {doc_type} threshold ({score} >= {threshold})"
                )
                print(f"  No further iterations needed!")
                results["final_image"] = str(iter_path)
                results["final_score"] = score
                results["success"] = True
                results["early_stop"] = True
                results["early_stop_reason"] = (
                    f"Quality score {score} meets threshold {threshold} for {doc_type}"
                )
                break

            # If this is the last iteration, we're done regardless
            if i == iterations:
                print(f"\n⚠ Maximum iterations reached")
                results["final_image"] = str(iter_path)
                results["final_score"] = score
                results["success"] = True
                break

            # Quality below threshold - improve prompt for next iteration
            print(f"\n⚠ Quality below threshold ({score} < {threshold})")
            print(f"Improving prompt based on feedback...")
            current_prompt = self.improve_prompt(user_prompt, critique, i + 1)

        # Copy final version to output path
        if results["success"] and results["final_image"]:
            final_iter_path = Path(results["final_image"])
            if final_iter_path != output_path:
                import shutil

                shutil.copy(final_iter_path, output_path)
                print(f"\n✓ Final image: {output_path}")

        # Save review log
        log_path = output_dir / f"{base_name}_review_log.json"
        with open(log_path, "w") as f:
            json.dump(results, f, indent=2)
        print(f"✓ Review log: {log_path}")

        print(f"\n{'=' * 60}")
        print(f"Generation Complete!")
        print(f"Final Score: {results['final_score']}/10")
        if results["early_stop"]:
            print(
                f"Iterations Used: {len([r for r in results['iterations'] if r.get('success')])}/{iterations} (early stop)"
            )
        print(f"{'=' * 60}\n")

        return results


def main():
    """Command-line interface."""
    parser = argparse.ArgumentParser(
        description="Generate scientific schematics using AI with smart iterative refinement",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate a flowchart for a journal paper
  python generate_schematic_ai.py "CONSORT participant flow diagram" -o flowchart.png --doc-type journal

  # Generate neural network architecture for presentation (lower threshold)
  python generate_schematic_ai.py "Transformer encoder-decoder architecture" -o transformer.png --doc-type presentation

  # Generate with custom max iterations for poster
  python generate_schematic_ai.py "Biological signaling pathway" -o pathway.png --iterations 2 --doc-type poster

  # Verbose output
  python generate_schematic_ai.py "Circuit diagram" -o circuit.png -v

Document Types (quality thresholds):
  journal      8.5/10  - Nature, Science, peer-reviewed journals
  conference   8.0/10  - Conference papers
  thesis       8.0/10  - Dissertations, theses
  grant        8.0/10  - Grant proposals
  preprint     7.5/10  - arXiv, bioRxiv, etc.
  report       7.5/10  - Technical reports
  poster       7.0/10  - Academic posters
  presentation 6.5/10  - Slides, talks
  default      7.5/10  - General purpose

Note: Multiple iterations only occur if quality is BELOW the threshold.
      If the first generation meets the threshold, no extra API calls are made.

Environment:
  GOOGLE_CLOUD_PROJECT  Google Cloud project ID
  GOOGLE_CLOUD_LOCATION Vertex location (default: global)
  GOOGLE_CLOUD_IMAGE_LOCATION Optional Vertex image location override (Imagen defaults to us-central1)
  VERTEX_ACCESS_TOKEN   Optional explicit access token
        """,
    )

    parser.add_argument("prompt", help="Description of the diagram to generate")
    parser.add_argument(
        "-o", "--output", required=True, help="Output image path (e.g., diagram.png)"
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=2,
        help="Maximum refinement iterations (default: 2, max: 2)",
    )
    parser.add_argument(
        "--doc-type",
        default="default",
        choices=[
            "journal",
            "conference",
            "poster",
            "presentation",
            "report",
            "grant",
            "thesis",
            "preprint",
            "default",
        ],
        help="Document type for quality threshold (default: default)",
    )
    parser.add_argument("--access-token", help="Explicit Vertex OAuth access token")
    parser.add_argument("--project", help="Google Cloud project ID (or use GOOGLE_CLOUD_PROJECT)")
    parser.add_argument("--location", default=None, help="Vertex AI location (default: GOOGLE_CLOUD_LOCATION or global)")
    parser.add_argument(
        "--image-location",
        default=None,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--image-model",
        default=None,
        choices=ScientificSchematicGenerator.SUPPORTED_IMAGE_MODELS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--review-model",
        default=None,
        choices=ScientificSchematicGenerator.SUPPORTED_REVIEW_MODELS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=None,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose output")

    args = parser.parse_args()

    # Validate iterations - enforce max of 2
    if args.iterations < 1 or args.iterations > 2:
        print("Error: Iterations must be between 1 and 2")
        sys.exit(1)

    try:
        generator = ScientificSchematicGenerator(
            access_token=args.access_token,
            project=args.project,
            location=args.location,
            image_model=args.image_model,
            image_location=args.image_location,
            review_model=args.review_model,
            request_timeout_seconds=args.timeout_seconds,
            verbose=args.verbose,
        )
        results = generator.generate_iterative(
            user_prompt=args.prompt,
            output_path=args.output,
            iterations=args.iterations,
            doc_type=args.doc_type,
        )

        if results["success"]:
            print(f"\n✓ Success! Image saved to: {args.output}")
            if results.get("early_stop"):
                print(
                    f"  (Completed in {len([r for r in results['iterations'] if r.get('success')])} iteration(s) - quality threshold met)"
                )
            sys.exit(0)
        else:
            print(f"\n✗ Generation failed. Check review log for details.")
            sys.exit(1)
    except Exception as e:
        print(f"\n✗ Error: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
