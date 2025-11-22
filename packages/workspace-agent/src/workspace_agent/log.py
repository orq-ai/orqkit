"""Logging configuration using loguru."""

import sys
from loguru import logger

# Remove default handler
logger.remove()

# Add stderr handler with custom format
logger.add(
    sys.stderr,
    level="DEBUG",
    format="<green>{time:HH:mm:ss}</green> | <level>{level:<8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
    colorize=True,
)

# Export logger for use throughout the package
__all__ = ["logger"]
