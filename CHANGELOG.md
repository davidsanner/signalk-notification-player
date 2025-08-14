# version 2.5.5:
  * Feature: All state changes get logged even if no sound method except when bouncing in/out of zone.
  * Refactor main event proccessing/queueing code to support full logging
  * Fix: look for specific anchor path when matching for anchor value, now using currentRadius
  * Change: switch to dark mode for app w/ black background
# version 2.5.1:
  * Feature: Persistant log of state changes, viewable via WebApp w/ mouse over State column
# version 2.4.0:
  * Feature: Ability to disable/mute individual notifcation paths, state saved between restarts
# version 2.2.0:
  * Feature: Custom delay before playing notifications to help with bouncing zone states
  * Fix: major refactor of event Q logic, adding fail safe features to assure all notifications are played
# version 2.1.0:
  * Feature: Webapp now controls and shows playback status (if disabled).
  * Fix: get notifications manually at startup as subscription missing notifications.
# version 2.0.1:
  * Fix: issue with instant notification subscription missing notifications at startup, get notifications manually for webapp
# version 2.0:
  * Feature: New companion webapp for viewing all notifications states and their corresponding values
  * Feature: webapp silence & resolve functions per notification & silence all button
# version 1.9:
  * Feature: to silence & resolve notifications as well as disable playback (with max timeout reset) accessed via curl/GET
  * Feature: new SK paths to allow digital switching control of these new silence, resolve & disable features.
  * Change: ignore bouncing rate configuration for emergency & alarm states - always play.
# version 1.8:
  * Feature: Slack support added for customize notifications. Update config layout.
# version 1.7:
  * Feature: Option to limit notification rate when bouncing in/out of a zone (eg. tank or depth zone)
# version 1.5.x:
  * Added custom features for each path, new mellow tritone sound, allow active notification to update if message changes
