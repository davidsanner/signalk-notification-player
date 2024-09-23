/*
 * Copyright 2024 David Sanner <davidsanner@big.net>
 * Copyright 2016 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


//const Bacon = require('baconjs');
const _ = require('lodash')
const path = require('path')
const child_process = require('child_process')

module.exports = function(app) {
  var plugin = {}
  plugin.id = "signalk-notification-player"
  plugin.name = "SignalK Notification Player"
  plugin.description = "Plugin that plays notification sounds"
  
  var unsubscribes = []
  var playing_sound = false
  var plugin_props
  var last_states = new Map()
  var enableNotificationTypes = []
  var playPID

  plugin.start = function(props) {
    plugin_props = props
    enableNotificationTypes['emergency'] = plugin_props.enableEmergencies
    enableNotificationTypes['alarm'] = plugin_props.enableAlarms
    enableNotificationTypes['warn'] = plugin_props.enableWarnings
    enableNotificationTypes['alert'] = plugin_props.enableAlerts

    if ( props.enableAlarms || props.enableWarnings)
    {
      subscribeToAlarms()
    }
  }

  plugin.stop = function() {
    unsubscribes.forEach(function(func) { func() })
    unsubscribes = []
  }

  function subscription_error(err)
  {
    app.error("error: " + err)
  }
  
  function got_delta(notification)
  {
    //app.debug("notification event: %o", notification)
    notification.updates.forEach(function(update) {
      update.values.forEach(function(value) {
        //app.debug("notification value: %o", value)
        if ( value.value != null
             && typeof value.value.state != 'undefined' )
        {
          if( typeof value.value.method != 'undefined'
            && value.value.method.indexOf('sound') != -1 )
          {
              continuous = false
              notice = false
              Object.keys(enableNotificationTypes).forEach(function(ntype) {
                  if ([ntype].indexOf(value.value.state) != -1 && enableNotificationTypes[ntype] == 'continuous') continuous=true
                  if ([ntype].indexOf(value.value.state) != -1 && enableNotificationTypes[ntype] == 'single notice') notice=true
              }); 

              if ( playing_sound == false && notice )
              {
                  play_notice()
              }
              if ( continuous )
              {
                last_states.set(value.path, value.value.state)
                if ( playing_sound == false ) {
                  play_continuous(value.value.state)
                }
              }
              else if ( last_states.has(value.path) )
              {
                last_states.delete(value.path)
              }
          }
          else if ( last_states.has(value.path) )
          {
                last_states.delete(value.path)
          }
        }
      })
    })
    //app.debug("PENDING "+last_states.size)
    if ( last_states.size === 0 && playing_sound) { 
      stop_playing_continuous()
    }
  }
    
  function stop_playing_continuous()
  {
    app.debug('stop playing')
    playing_sound = false
    if (playPID) process.kill(playPID)
    if ( plugin_props.postCommand && plugin_props.postCommand.length > 0 ) {
      const { exec } = require('node:child_process')
      app.debug("post command: %s", plugin_props.postCommand)
      exec(plugin_props.postCommand)
    } 
  }

  function play_continuous(state)
  {
    app.debug("play_continuous")

    if (  playing_sound != true && plugin_props.preCommand && plugin_props.preCommand.length > 0 ) { 
      const { exec } = require('node:child_process')
      app.debug("pre command: %s", plugin_props.preCommand)
      exec(plugin_props.preCommand)
    }

    playing_sound = true

    let command = plugin_props.alarmAudioPlayer
    app.debug("sound_player: " + command)

    let sound_file = plugin_props.alarmAudioFile
    if ( sound_file && sound_file.charAt(0) != '/' )
    {
      sound_file = path.join(__dirname, sound_file)
    }
    let args = [ sound_file ]
    if ( plugin_props.alarmAudioPlayerArguments && plugin_props.alarmAudioPlayerArguments.length > 0 ) {
      args = [ ...plugin_props.alarmAudioPlayerArguments.split(' '), ...args ]
    }

    app.debug("sound command: %s %j", command, args)
    
    let play = child_process.spawn(command, args)
    playPID = play.pid

    play.on('error', (err) => {
      playPID = undefined
      app.error("failed to play sound " + err)
    });

    play.on('close', (code) => {
      if ( code == 0 )
      {
        playPID = undefined
        if ( last_states.size > 0 )
          play_continuous(state)
      }
      else
      {
        playPID = undefined
        app.debug("error playing sound")
      }
    });
  }

  function play_notice()
  {
    app.debug("play_notice")

    let command = plugin_props.alarmAudioPlayer
    app.debug("sound_player: " + command)

    let sound_file = plugin_props.warnAudioFile
    if ( sound_file && sound_file.charAt(0) != '/' )
    {
      sound_file = path.join(__dirname, sound_file)
    }
    let args = [ sound_file ]
    if ( plugin_props.alarmAudioPlayerArguments && plugin_props.alarmAudioPlayerArguments.length > 0 ) {
      args = [ ...plugin_props.alarmAudioPlayerArguments.split(' '), ...args ]
    }

    app.debug("sound command: %s %j", command, args)
    
    let play = child_process.spawn(command, args)

    play.on('error', (err) => {
      app.error("failed to play warning sound " + err)
    });
  }

  plugin.schema = function() {

    let defaultAudioPlayer = 'mpg321'

    let schema = {
      title: "Alarm Player",
          description: "Select response for each notification type:",
      type: "object",
      required: [
        "alarmAudioFile"
      ],
      properties: {
        enableEmergencies: {
          type: "string",
          "enum": ["continuous", "single notice", "mute"],
          title: "Emergency Notification Type",
          default: "continuous"
        },
        enableAlarms: {
          type: "string",
          "enum": ["continuous", "single notice", "mute"],
          title: "Alarm Notification Type",
          default: "continuous"
        },
        enableWarnings: {
          type: "string",
          "enum": ["continuous", "single notice", "mute"],
          title: "Warning Notification Type",
          default: "notice"
        },
        enableAlerts: {
          type: "string",
          "enum": ["continuous", "single notice", "mute"],
          title: "Alert Notification Type",
          default: "mute"
        },
        preCommand: {
          title: "Command before playing alarm/emergency",
          description: "optional command to run before playing alarm or emergency",
          type: "string"
        },
        postCommand: {
          title: "Command after playing alarm/emergency",
          description: "optional command to run after alarm or emergency is cleared",
          type: "string"
        },
        alarmAudioFile: {
          type: "string",
          title: "Path to audio file for continuous audio notification",
          default: "builtin_alarm.mp3"
        },
        warnAudioFile: {
          type: "string",
          title: "Path to audio file for single notice",
          default: "builtin_notice.mp3"
        },
        alarmAudioPlayer: {
          title: "Audio Player",
          description: "Select command line audio player",
          type: "string",
          default: defaultAudioPlayer,
          "enum": ["afplay", "omxplayer", "mpg321"]
        },
        alarmAudioPlayerArguments: {
          title: "Audio Player Arguments",
          description: "Arguments to add to the audio player command",
          type: "string"
        }
      }
    }
    return schema
  }

  function subscribeToAlarms()
  {
    const command = {
      context: "vessels.self",
      subscribe: [{
        path: "notifications.*",
        policy: 'instant'
      }]
    } 
    app.subscriptionmanager.subscribe(command, unsubscribes, subscription_error, got_delta)
  }

  return plugin;
}
