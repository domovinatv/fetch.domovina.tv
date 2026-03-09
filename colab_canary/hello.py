#!/usr/bin/env python3
"""Brzi test da push/pull radi."""

import torch

print("Hello from Colab!")
print(f"Python radi, torch version: {torch.__version__}")
print(f"CUDA dostupan: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
