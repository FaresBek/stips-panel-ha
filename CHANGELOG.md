# 1.5.16

- Delete offline screens: **Delete offline screen** under Remote actions (shown while the selected screen is offline). Its backups and revision history are kept, and it reappears automatically when the panel comes back online.
- Navigator style (`navigation.barStyle`: default, match cards, blur, transparent) and alert audio output (`alerts.audioOutput`: alarm or media) in the editor.
- Demo/showroom settings removed from the editor; existing values pass through untouched.
- Compatible with STIPS Panel Android 1.8.7; storage version 1 and complete project snapshots are unchanged.

# 1.5.9

- Live card preview from Home Assistant states.
- Preview "Pack cards into gaps" with the panel's packing; fixed-row previews no longer overflow.
- Duplicate, reorder and size-preset cards from the inspector or the preview.
- Import dashboards from another screen or a shared dashboard into the draft.
- Add read-only `list_dashboards` / `get_dashboards` response services for panel dashboard discovery.
- Compatible with STIPS Panel Android 1.8.0; storage version 1 and complete project snapshots are unchanged.

# 1.5.8

- Add STIPS Alerts activation source, control entity, Follow HA / Two-way control mode and the entity's current state.
- Add arming delay, alarm delay and a per-sensor alarm delay column in the rules editor.
- Keep rule ids, enabled flags and unknown fields when the rules text is edited.
- Compatible with STIPS Panel Android 1.7.0; storage version 1 and complete project snapshots are unchanged.

# 1.5.7

- Add Room ON behavior, Room and Room Popup gesture actions, Room Popup Cards and Page Popup Cards.

# 1.5.6

- Add Room Card area, filter, entity override, layout and Room OFF configuration.
- Add Slider/Shutter Cover-card configuration.
- Remove production showroom controls and force Demo Mode off on editor pushes.
- Preserve storage version 1 and complete project snapshots.

# 1.5.3

- Publish the Home Assistant integration from a dedicated public HACS repository.
- Keep the bundled editor, UI configuration flow and automatic sidebar registration.
- Preserve storage version 1, existing screen data and complete project snapshots.

