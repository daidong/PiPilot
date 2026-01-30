import os
import json
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
import warnings
warnings.filterwarnings('ignore')

def write_results(outputs=None, summary=None):
    """Write the results manifest JSON. Call this at the end of your script."""
    manifest = {
        "outputs": outputs or [],
        "summary": summary or {},
        "warnings": []
    }
    with open(RESULTS_FILE, 'w') as f:
        json.dump(manifest, f, indent=2, default=str)
    print(f"Results manifest written to {RESULTS_FILE}")
