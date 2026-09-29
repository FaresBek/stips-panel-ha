# STIPS Panel Remote Manager

The Home Assistant integration and visual dashboard editor for STIPS Panel Android wall panels.

[![Open STIPS Panel Remote Manager in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=FaresBek&repository=stips-panel-ha&category=integration)

This public repository contains only the Home Assistant distribution. The commercial Android application is maintained separately. Remote Manager **1.5.6** is compatible with STIPS Panel Android **1.6.1** and preserves existing manager storage, screen history, projects and deployed revisions.

## Install with HACS

1. Select the HACS button above.
2. Add `FaresBek/stips-panel-ha` as an **Integration** repository if HACS asks you to confirm the custom repository.
3. Download **STIPS Panel Remote Manager** and restart Home Assistant.
4. Open **Settings > Devices & services > Add integration**, search for **STIPS Panel Remote Manager**, and add it.
5. Open **STIPS Panels** in the Home Assistant sidebar.

The integration serves its bundled editor at `/stips-panel/static`; no files need to be copied into `/config/www` and no `panel_custom` YAML entry is required.

## Upgrade from a manual installation

1. Install this repository through HACS.
2. Restart Home Assistant and confirm that **STIPS Panels** opens.
3. Remove the old `panel_custom` entry for `stips-panel-editor` from `configuration.yaml`.
4. Remove `/config/www/stips-panel-editor.js` after confirming the HACS installation works.

Existing `stips_panel:` YAML remains supported. You can keep it or configure the integration through Home Assistant's UI.

## Manual fallback

Download `stips-panel-remote-manager.zip` from the latest release and extract its contents into:

```text
<config>/custom_components/stips_panel
```

Restart Home Assistant, then add **STIPS Panel Remote Manager** from **Settings > Devices & services**.

## Safety and compatibility

The editor always starts from the complete project snapshot supplied by the Android panel or stored by Home Assistant. Fields that the visual editor does not understand remain in the snapshot instead of being discarded. Dashboard pushes create versioned desired revisions; the Android client validates and applies them atomically.

Remote Manager 1.5.6 retains storage version 1 and is an in-place upgrade from the 1.4.x and 1.5.x releases.

## Development

Validate the integration and build the HACS release archive with:

```shell
python tools/validate.py
python tools/build_release.py
node --check custom_components/stips_panel/frontend/stips-panel-editor.js
```

The matching Android-model compatibility verification runs in the private STIPS Panel development repository before a distribution update is published here.

## Release 1.5.6

- Add complete Room Card creation and editing for Home Assistant areas.
- Add Slider/Shutter Cover-card configuration while keeping Slider as the migration default.
- Remove showroom and Demo Mode controls from the production editor.
- Force Demo Mode off on production pushes while preserving complete project snapshots.

## Release 1.5.3

- Move HACS installation and updates to this dedicated public repository.
- Keep the Android application and its history outside the public distribution.
- Point integration documentation and issues to this repository.
- Preserve existing data, dashboard revisions and full project snapshots.

