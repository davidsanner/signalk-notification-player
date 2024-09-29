Signal K plugin for audio notifications
=================================

This plugin plays user configurable sounds and/or text-to-speech when a Signal K notification enters emergency/alarm/warn/notice state.

Audio playback is configurable to repeat continuously or play a one time notification sound/speech.

Each state (emergency/alarm/warn/notice) can be configure independently with the option to create custom playback based on specific notification path & state.
Custom commands can be initiated before and after a continuous notification plays.

All notifications are queued and play the sound first followed by message if available, repeating as configured.


## Dependencies

* Working speaker connected to your computer running Signal K
* Sound player:  afplay (mac), omxplayer, mpg321 (linux & win)
* Linux specific speech synthesis dependencies: `festival festvox-kallpc16k`

## Supplied Sounds

* builtin_alarm.mp3
* builtin_notice.mp3
* builtin_sonar.mp3
