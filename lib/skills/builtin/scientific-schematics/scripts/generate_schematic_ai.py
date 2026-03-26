#!/usr/bin/env python3
"""
AI-powered scientific schematic generation using OpenRouter API.

This script uses a smart iterative refinement approach:
1. Generate initial image with Gemini image model via OpenRouter
2. AI quality review using Gemini for scientific critique
3. Only regenerate if quality is below threshold for document type
4. Repeat until quality meets standards (max iterations)

Requirements:
    - OPENROUTER_API_KEY environment variable
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

    # Try the package's parent directory (project root)
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


OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"


class ScientificSchematicGenerator:
    """Generate scientific schematics using AI with smart iterative refinement.

    Uses Gemini review to determine if regeneration is needed.
    Multiple passes only occur if the generated schematic doesn't meet the
    quality threshold for the target document type.
    """

    # Quality thresholds by document type (score out of 10)
    QUALITY_THRESHOLDS = {
        "journal": 8.5,
        "conference": 8.0,
        "poster": 7.0,
        "presentation": 6.5,
        "report": 7.5,
        "grant": 8.0,
        "thesis": 8.0,
        "preprint": 7.5,
        "default": 7.5,
    }

    DEFAULT_IMAGE_MODEL = "google/gemini-3-pro-image-preview"
    DEFAULT_REVIEW_MODEL = "google/gemini-3-pro-preview"
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
        api_key: Optional[str] = None,
        image_model: Optional[str] = None,
        review_model: Optional[str] = None,
        request_timeout_seconds: Optional[int] = None,
        verbose: bool = False,
    ):
        """
        Initialize the generator.

        Args:
            api_key: OpenRouter API key
            image_model: Model ID for image generation (OpenRouter format)
            review_model: Model ID for quality review (OpenRouter format)
            request_timeout_seconds: Request timeout for API calls
            verbose: Print detailed progress information
        """
        _load_env_file()
        self.verbose = verbose
        self._last_error = None

        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OPENROUTER_API_KEY is not set.\n"
                "Set OPENROUTER_API_KEY environment variable or pass --api-key."
            )

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
        self.request_timeout_seconds = self._parse_timeout_seconds(
            request_timeout_seconds
            or os.getenv("SCHEMATIC_REQUEST_TIMEOUT_SECONDS")
        )

    def _parse_timeout_seconds(self, value: Optional[Any]) -> int:
        try:
            parsed = int(str(value).strip()) if value is not None else 0
        except (TypeError, ValueError):
            parsed = 0
        return max(parsed, 30) if parsed else self.DEFAULT_REQUEST_TIMEOUT_SECONDS

    def _log(self, message: str):
        """Log message if verbose mode is enabled."""
        if self.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {message}")

    def _post_openrouter(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Make a request to OpenRouter chat completions API.

        Args:
            model: Model identifier (OpenRouter format, e.g. google/gemini-3-pro-image-preview)
            messages: List of message dictionaries in OpenAI format
            timeout_seconds: Optional timeout override

        Returns:
            API response as dictionary
        """
        timeout = timeout_seconds or self.request_timeout_seconds
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/research-copilot",
            "X-Title": "Research Copilot Scientific Schematics",
        }
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
        }

        self._log(f"Making request to OpenRouter with model {model}...")

        try:
            response = requests.post(
                OPENROUTER_API_URL,
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

    def _extract_image_from_response(self, response: Dict[str, Any]) -> Optional[bytes]:
        """
        Extract image bytes from an OpenRouter response.

        Handles multiple response formats:
        1. message.images array with image_url data URIs (Gemini via OpenRouter)
        2. Multipart content array with inline_data (Gemini native)
        3. Content array with image_url data URIs
        4. Base64 image data in content string

        Returns:
            Image bytes or None if not found
        """
        try:
            choices = response.get("choices", [])
            if not choices:
                self._log("No choices in response")
                return None

            message = choices[0].get("message", {})

            # Case 0: message.images array (OpenRouter Gemini image generation format)
            # The API returns content=null but images=[{type: "image_url", image_url: {url: "data:..."}}]
            images = message.get("images")
            if isinstance(images, list):
                for index, img in enumerate(images):
                    if not isinstance(img, dict):
                        continue
                    # Handle {type: "image_url", image_url: {url: "data:image/png;base64,..."}}
                    if img.get("type") == "image_url":
                        image_url = img.get("image_url", {})
                        url = image_url.get("url", "") if isinstance(image_url, dict) else str(image_url)
                        if url.startswith("data:") and "," in url:
                            _, b64data = url.split(",", 1)
                            self._log(f"Found image in message.images[{index}]")
                            return base64.b64decode(b64data)
                    # Handle direct {url: "data:..."} format
                    url = img.get("url", "")
                    if url.startswith("data:") and "," in url:
                        _, b64data = url.split(",", 1)
                        self._log(f"Found image in message.images[{index}] (direct url)")
                        return base64.b64decode(b64data)

            content = message.get("content", "")

            # Case 1: content is a list of parts (multimodal response)
            if isinstance(content, list):
                for index, part in enumerate(content):
                    if not isinstance(part, dict):
                        continue

                    # Check for inline_data (Gemini native format passed through)
                    inline_data = part.get("inline_data", {})
                    if isinstance(inline_data, dict) and inline_data.get("data"):
                        data = str(inline_data["data"]).replace("\n", "").replace("\r", "").replace(" ", "")
                        self._log(f"Found image in inline_data part {index}")
                        return base64.b64decode(data)

                    # Check for image_url with data URI
                    if part.get("type") == "image_url":
                        image_url = part.get("image_url", {})
                        url = image_url.get("url", "") if isinstance(image_url, dict) else str(image_url)
                        if url.startswith("data:") and "," in url:
                            _, b64data = url.split(",", 1)
                            self._log(f"Found image in image_url part {index}")
                            return base64.b64decode(b64data)

                self._log("No image data found in content parts")
                return None

            # Case 2: content is a string — might contain base64 image in markdown
            if isinstance(content, str) and content:
                # Look for markdown image with base64
                match = re.search(r'!\[.*?\]\(data:image/[^;]+;base64,([A-Za-z0-9+/=\s]+)\)', content)
                if match:
                    b64data = match.group(1).replace("\n", "").replace("\r", "").replace(" ", "")
                    self._log("Found base64 image in markdown content")
                    return base64.b64decode(b64data)

                # Look for raw base64 block (some models return just the data)
                stripped = content.strip()
                if len(stripped) > 1000 and re.match(r'^[A-Za-z0-9+/=\n\r]+$', stripped):
                    try:
                        data = base64.b64decode(stripped.replace("\n", "").replace("\r", ""))
                        # Verify it's actually an image (PNG or JPEG magic bytes)
                        if data[:4] == b'\x89PNG' or data[:2] == b'\xff\xd8':
                            self._log("Found raw base64 image in content string")
                            return data
                    except Exception:
                        pass

            self._log("No image data found in response")
            return None

        except Exception as e:
            self._log(f"Error extracting image: {str(e)}")
            if self.verbose:
                import traceback
                traceback.print_exc()
            return None

    def _image_to_base64_url(self, image_path: str) -> str:
        """
        Convert image file to a data URI for use in OpenAI-compatible messages.

        Args:
            image_path: Path to image file

        Returns:
            Data URI string (data:image/png;base64,...)
        """
        with open(image_path, "rb") as f:
            image_data = f.read()

        ext = Path(image_path).suffix.lower()
        mime_type = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }.get(ext, "image/png")

        b64 = base64.b64encode(image_data).decode("utf-8")
        return f"data:{mime_type};base64,{b64}"

    def generate_image(self, prompt: str) -> Optional[bytes]:
        """
        Generate an image using the image model via OpenRouter.

        Args:
            prompt: Description of the diagram to generate

        Returns:
            Image bytes or None if generation failed
        """
        self._last_error = None

        try:
            messages = [{"role": "user", "content": prompt}]
            response = self._post_openrouter(
                model=self.image_model,
                messages=messages,
            )
            image_data = self._extract_image_from_response(response)

            if self.verbose:
                self._log(f"Response keys: {response.keys()}")
                if "error" in response:
                    self._log(f"API Error: {response['error']}")
                choices = response.get("choices", [])
                if choices:
                    msg = choices[0].get("message", {})
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        self._log(f"Content part count: {len(content)}")
                        for i, part in enumerate(content[:3]):
                            if isinstance(part, dict):
                                self._log(f"  Part {i}: keys={list(part.keys())}")
                    elif isinstance(content, str):
                        self._log(f"Content is string, length={len(content)}")

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
                    f"No image data in response for model {self.image_model}"
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
            if self.verbose:
                import traceback
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
        Review generated image using a multimodal model for quality analysis.

        Args:
            image_path: Path to the generated image
            original_prompt: Original user prompt
            iteration: Current iteration number
            doc_type: Document type (journal, poster, presentation, etc.)
            max_iterations: Maximum iterations allowed

        Returns:
            Tuple of (critique text, quality score 0-10, needs_improvement bool)
        """
        image_data_url = self._image_to_base64_url(image_path)

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
                        "image_url": {"url": image_data_url},
                    },
                ],
            }
        ]

        try:
            response = self._post_openrouter(model=self.review_model, messages=messages)

            choices = response.get("choices", [])
            if not choices:
                return "Image generated successfully", 8.0, False

            message = choices[0].get("message", {})
            content = message.get("content", "")

            # Handle content as string or list of parts
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(str(block.get("text", "")))
                    elif isinstance(block, str):
                        text_parts.append(block)
                content = "\n".join(text_parts)

            if not isinstance(content, str):
                content = str(content)

            # Extract score
            score = 7.5  # Default

            score_match = re.search(r"SCORE:\s*(\d+(?:\.\d+)?)", content, re.IGNORECASE)
            if score_match:
                score = float(score_match.group(1))
            else:
                score_match = re.search(
                    r"(?:score|rating|quality)[:\s]+(\d+(?:\.\d+)?)\s*(?:/\s*10)?",
                    content,
                    re.IGNORECASE,
                )
                if score_match:
                    score = float(score_match.group(1))

            # Determine if improvement is needed
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
            return "Image generated successfully (review skipped)", 7.5, False

    def improve_prompt(
        self, original_prompt: str, critique: str, iteration: int
    ) -> str:
        """
        Improve the generation prompt based on critique.
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
        specified document type.

        Args:
            user_prompt: User's description of desired diagram
            output_path: Path to save final image
            iterations: Maximum refinement iterations (default: 2, max: 2)
            doc_type: Document type for quality threshold

        Returns:
            Dictionary with generation results and metadata
        """
        output_path = Path(output_path)
        output_dir = output_path.parent
        output_dir.mkdir(parents=True, exist_ok=True)

        base_name = output_path.stem
        extension = output_path.suffix or ".png"

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
        print(f"Image Model: {self.image_model}")
        print(f"Review Model: {self.review_model}")
        print(f"Output: {output_path}")
        print(f"{'=' * 60}\n")

        for i in range(1, iterations + 1):
            print(f"\n[Iteration {i}/{iterations}]")
            print("-" * 40)

            # Generate image
            print(f"Generating image...")
            image_data = self.generate_image(current_prompt)

            if not image_data:
                error_msg = self._last_error or "Image generation failed - no image data returned"
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

            # Review image
            print(f"Reviewing image...")
            critique, score, needs_improvement = self.review_image(
                str(iter_path), user_prompt, i, doc_type, iterations
            )
            print(f"✓ Score: {score}/10 (threshold: {threshold}/10)")

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

            # Check if quality is acceptable
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

            if i == iterations:
                print(f"\n⚠ Maximum iterations reached")
                results["final_image"] = str(iter_path)
                results["final_score"] = score
                results["success"] = True
                break

            # Quality below threshold — improve prompt
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
  OPENROUTER_API_KEY            Required. Your OpenRouter API key.
  SCHEMATIC_IMAGE_MODEL         Optional. Override image generation model (default: google/gemini-3-pro-image-preview)
  SCHEMATIC_REVIEW_MODEL        Optional. Override review model (default: google/gemini-3-pro-preview)
  SCHEMATIC_REQUEST_TIMEOUT_SECONDS  Optional. Request timeout in seconds.
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
    parser.add_argument("--api-key", help="OpenRouter API key (or use OPENROUTER_API_KEY)")
    parser.add_argument(
        "--image-model",
        default=None,
        help="Image generation model (default: google/gemini-3-pro-image-preview)",
    )
    parser.add_argument(
        "--review-model",
        default=None,
        help="Review model (default: google/gemini-3-pro-preview)",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=None,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose output")

    args = parser.parse_args()

    # Validate iterations
    if args.iterations < 1 or args.iterations > 2:
        print("Error: Iterations must be between 1 and 2")
        sys.exit(1)

    try:
        generator = ScientificSchematicGenerator(
            api_key=args.api_key,
            image_model=args.image_model,
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
