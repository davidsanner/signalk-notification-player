<img width="128" alt="WebApp" src="public/icon.png" /> Signal K - Notification Player w/ Webapp
=================================

This plugin plays user configurable sounds and/or text to speech when a Signal K notification enters emergency/alarm/warn/notice state.
Custom notifications can also be sent to user configured slack channel.  The paired Webapp displays all known/configured notifications as well as 
controls for silencing and clearing active notification states and displaying recent zone log history. A persistant log is kept for all zone changes, even when not playing audio or state zone method is defined.  Use cases including tracking basic logging of digital switching or misc events like engine state, movement status or node red flags.


The playback options for each state (emergency,alarm,warn,notice) can be configure independently with the option to create custom playback rules for a specific path & state.  Custom commands can be initiated before and after a notification plays (eg. pause music, change volume, flash lights).

A state's notification playback can be configured to repeat continuously (eg. emergency) or output a one time notification sound + speech (eg. notice).  Continuous playback stops when a notification's state returns to 'normal' or 'sound' is removed from its method (muted/silenced).  All notifications are queued in order and play the sound first followed by a message/speech if available, repeating as configured.  

Example usage: a zone for a elevated coolant or alternator temperature could trigger a single play/speech event while an overheat zone would send a continuous output/alarm.  A similar setup could be used for depth or battery SOC.  An anchor alarm would be customized to play continously, perhaps with a unique attention grabbing sound alternating with 'Anchor Alarm - Emergency' text to speech.

### Initial configuration of each notification state 
<img width="608" alt="Alert State Configuration" src="https://github.com/user-attachments/assets/bfaab30b-7d2d-4430-b093-f8a626d14a59" />


Customized alarm for specific path & notification state
<img width="600" alt="Custom Path Configuration" src="https://github.com/user-attachments/assets/3232464b-4594-4447-b201-481dc60d3967" />

### WebApp - State Viewer and Control

Companion webapp for viewing all notifications states and their corresponding values.  This page can be easily embedded into Kip for quick state view and playback control/silencing  
<img width="706" alt="snkp-zone2" src="https://github.com/user-attachments/assets/2c923776-53c9-47e4-bc8b-4ef64cc31bcc" />


Mouse over any path to view its notifcation zones and type  
<img width="623" alt="sknp-zones" src="https://github.com/user-attachments/assets/16cebb46-a2d7-4827-822a-772b28e7d32a" />

Mouse over the State column of any path (eg. normal) to view log of past notifications.
<img width="365" alt="notification-player-log" src="https://github.com/user-attachments/assets/68b314ec-77ca-4cb4-8ee6-63403d036ac5" />


### API - Control of Playback & Active Notifications
Active notifications can be silenced (sound removed from method) or resolved (state set to normal) via a simple GET of the following URLs

Silence all active playback (clears sound notification method)
```
curl http://localhost:3000/plugins/signalk-notification-player/silence
```
Resolve all active notifications (set state to normal)
```
curl http://localhost:3000/plugins/signalk-notification-player/resolve
```
Disable all playback for 1 hour (default), max 8hr.
```
curl http://localhost:3000/plugins/signalk-notification-player/disable
```
Custom disable all playback for 5 minutes ( max value 28800 / ie 8hrs )
```
curl http://localhost:3000/plugins/signalk-notification-player/disable?300
```
Custom disable playback for specific path (args: path & true/false )
```
curl http://localhost:3000/plugins/signalk-notification-player/disablePath?electrical.batteries.House.voltage?true
```
Custom disable playback for last alert path (map to a keystroke to quickly silence & disable)
```
curl http://localhost:3000/plugins/signalk-notification-player/disableLast
```
List all known notifcation states & associated value (json)
```
curl http://localhost:3000/plugins/signalk-notification-player/list
```
List log of notifications (json) (log?path?numberDisplayed)
```
curl http://localhost:3000/plugins/signalk-notification-player/log?navigation.gnss.horizontalDilution?25
curl http://localhost:3000/plugins/signalk-notification-player/log?20  (show last 20, any path)
```
While playback is disabled, incoming notifications will still be queued and played in order, once re-enabled the latest / current notification for a given path will be processed for playback.

Example using authentication data with user pi
```
curl -H 'Cookie: JAUTHENTICATION='$(signalk-generate-token -u pi -e 1y -s ~pi/.signalk/security.json)  http://localhost:3000/plugins/signalk-notification-player/silence
```

Silence, Resolve and Disable functions are availble via these corresponding paths which can be set via the included webapp, webapps like Kip's boolean control panel or NodeRed :
```
digital.notificationPlayer.silence  (clear sound method from all active notifications)
digital.notificationPlayer.resolve  (set all active notifications to normal)
digital.notificationPlayer.disable  (will reset/enable playback after 60min)
```
(Set above path prefix under Plugin Config - default: digital.notificationPlayer )
Example of alarm playback control via the Kip Webapp

<img width="280" alt="Kip Example" src="https://github.com/user-attachments/assets/8c960cf9-0afe-46bc-995f-a078f06c7a0d" />


### Background
A Signal K path can have one or more zones associated with it. Zones are specified in a path's meta data which can be defined/edited using SK Data Browser /w Meta Data enabled (or generated by plugins like signalk-anchoralarm-plugin). For audio playback, a path's zone needs an associated method (eg. emergencyMethod) with sound enabled.
When a Signal K path's value (eg. environment.depth.belowSurface = 3) enters the range specified in a zone, the state of its associated notification is updated. This state update could trigger this plugin to play an audio notification/text to speech.  
Webapps like KIP can be used to silence or resolve active notifications.  
(note: zones defined by the older @signalk/zones plugin has issues with KIP if entries are 'Active'. To migrate zone configuration from @signalk/zones plugin to use SK server directly, click edit and then save for each path with a zone shown under SK Data Browser. Then disable then @signalk/zones plugin.)


## Dependencies

* Working speaker connected to your computer running Signal K
* Sound player:  `afplay (mac), omxplayer, mpg321 & mpg123` (linux & win)
* Linux specific speech synthesis dependencies: `festival festvox-kallpc16k`

## Supplied Sounds

* builtin_alarm.mp3
* builtin_notice.mp3
* builtin_sonar.mp3
* builtin_tritone.mp3

