# <img src="public/icon.png" width="72" height="72" style="vertical-align: middle; margin-right: 20px;"> Signal K Notification Player with Webapp

This Signal K plugin plays user-configurable sounds and/or text-to-speech when a Signal K notification enters an emergency, alarm, warn, or notice state. Custom notifications can also be sent to a user-configured Slack channel.

The paired webapp displays all known and configured notifications, along with controls for silencing and clearing active notification states. It also shows recent zone log history.

A persistent log is kept for all zone changes, even when audio is not playing or when no state zone method is defined. Use cases include basic logging of digital switching or miscellaneous events like engine state, movement status, or Node-RED flags.

## Key Features

- **Playback Options**: Independently configure playback for each state (emergency, alarm, warn, notice). Create custom playback rules for specific paths and states.
- **Custom Commands**: Initiate commands before and after a notification plays (e.g., pause music, change volume, flash lights).
- **Repeat Behavior**: Configure a state's notification playback to repeat continuously (e.g., emergency) or play once (e.g., notice).
- **Queuing**: All notifications are queued in order. Sound plays first, followed by message/speech if available, repeating as configured.
- **Stopping Playback**: Continuous playback stops when a notification's state returns to 'normal' or 'sound' is removed from its method (muted/silenced).

**Example Usage**:
- A zone for elevated coolant or alternator temperature could trigger a single play/speech event.
- An overheat zone would send continuous output/alarm.
- Similar setups could apply to depth or battery SOC.
- An anchor alarm could play continuously, alternating a unique attention-grabbing sound with "Anchor Alarm - Emergency" text-to-speech.

### Initial configuration of each notification state 
<img width="608" alt="Alert State Configuration" src="https://github.com/user-attachments/assets/bfaab30b-7d2d-4430-b093-f8a626d14a59" />


Customized alarm for specific path & notification state
<img width="600" alt="Custom Path Configuration" src="https://github.com/user-attachments/assets/3232464b-4594-4447-b201-481dc60d3967" />

## WebApp - State Viewer and Control

Companion webapp for viewing all notifications states and their corresponding values.  This page can be easily embedded into Kip for quick state view and playback control/silencing  
<img width="706" alt="snkp-zone2" src="https://github.com/user-attachments/assets/2c923776-53c9-47e4-bc8b-4ef64cc31bcc" />


Mouse over any path to view its notifcation zones and type  
<img width="623" alt="sknp-zones" src="https://github.com/user-attachments/assets/16cebb46-a2d7-4827-822a-772b28e7d32a" />

Mouse over the State column of any path (eg. normal) to view log of past notifications.
<img width="365" alt="notification-player-log" src="https://github.com/user-attachments/assets/68b314ec-77ca-4cb4-8ee6-63403d036ac5" />

## API - Control of Playback & Active Notifications

Active notifications can be silenced (sound removed from method) or resolved (state set to normal) via simple GET requests to the following URLs.

- **Silence all active playback** (clears sound notification method):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/silence
  ```

- **Resolve all active notifications** (set state to normal):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/resolve
  ```

- **Disable all playback for 1 hour** (default, max 8 hours):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/disable
  ```

- **Custom disable all playback for 5 minutes** (max value 28800, i.e., 8 hours):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/disable?300
  ```

- **Custom disable playback for specific path** (args: path & true/false):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/disablePath?electrical.batteries.House.voltage?true
  ```

- **Custom disable playback for last alert path** (map to a keystroke to quickly silence & disable):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/disableLast
  ```

- **List all known notification states & associated values** (JSON):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/list
  ```

- **List log of notifications** (JSON) (`log?path?numberDisplayed`):
  ```
  curl http://localhost:3000/plugins/signalk-notification-player/log?navigation.gnss.horizontalDilution?25
  curl http://localhost:3000/plugins/signalk-notification-player/log?20  # Show last 20 for any path
  ```

While playback is disabled, incoming notifications will still be queued and played in order. Once re-enabled, the latest/current notification for a given path will be processed for playback.

**Example using authentication** (with user `pi`):
```
curl -H 'Cookie: JAUTHENTICATION='$(signalk-generate-token -u pi -e 1y -s ~pi/.signalk/security.json) http://localhost:3000/plugins/signalk-notification-player/silence
```

**Signal K Paths for Control**:
Silence, resolve, and disable functions are available via these paths, which can be set via the included webapp, webapps like Kip's boolean control panel, or Node-RED:

- `digital.notificationPlayer.silence` (clear sound method from all active notifications)
- `digital.notificationPlayer.resolve` (set all active notifications to normal)
- `digital.notificationPlayer.disable` (will reset/enable playback after 60 min)

(Set the above path prefix under Plugin Config - default: `digital.notificationPlayer`.)

**Example of Alarm Playback Control via the Kip Webapp**:
![Kip Example](https://github.com/davidsanner/signalk-notification-player/raw/main/images/kip-example.png?raw=true)

## Background

A Signal K path can have one or more zones associated with it. Zones are specified in a path's metadata, which defines thresholds and associated notification states. This plugin monitors these zones and triggers audio notifications accordingly.

For more details on Signal K notifications and zones, refer to the [Signal K documentation](https://signalk.org/specification/1.7/doc/notifications.html).

