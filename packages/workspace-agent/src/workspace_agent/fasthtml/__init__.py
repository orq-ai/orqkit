"""FastHTML UI for workspace agent."""

# Lazy imports to avoid loading FastHTML when not needed
def get_app():
    """Get the FastHTML app instance."""
    from .app import app
    return app


def serve():
    """Run the FastHTML app."""
    from .app import serve as _serve
    _serve()


__all__ = ["get_app", "serve"]
