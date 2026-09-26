"""Constants for STIPS Panel Remote Manager."""
DOMAIN = "stips_panel"
# Keep the storage format at v1 so existing installations upgrade in place; V1.5.x adds optional
# top-level keys and remains backward-compatible with the existing stored dictionary.
STORAGE_VERSION = 1
STORAGE_KEY = "stips_panel.remote_manager"
EVENT_PUSH = "stips_panel_push"
MAX_REVISIONS = 20
ONLINE_TIMEOUT_SECONDS = 150
