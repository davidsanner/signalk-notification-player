/*
 * Copyright 2024 David Sanner 
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

const _ = require('lodash')
const fs = require('fs')
const path = require('path')
const child_process = require('child_process')
const say = require('say');

module.exports = function(app) {
  var plugin = {}
  plugin.id = 'signalk-notification-player'
  plugin.name = 'Notification Player'
  plugin.description = 'Plugin that plays notification sounds/speech'
 
  
  var unsubscribes = []
  var playing_sound = false
  var plugin_props
  var last_states = new Map()
  var playPID
  var queueIndex = 0
  var hasFestival = false
  var notificationFiles = ['builtin_alarm.mp3', 'builtin_notice.mp3', 'builtin_sonar.mp3', 'builtin_tritone.mp3']
  var notificationSounds = {'emergency': notificationFiles[0], 'alarm': notificationFiles[1], 'warn': notificationFiles[2], 'alert': notificationFiles[3]}
  var enableNotificationTypes = {'emergency': 'continuous', 'alarm': 'continuous', 'warn': 'single notice', 'alert': 'single notice'}
  var notificationPrePost = {'emergency': true, 'alarm': true, 'warn': false, 'alert': false}
  const soundEvent = { path: '', state: '', audioFile: '', message: '', mode: '', played: 0, numNotifications: 0}

  plugin.start = function(props) {
    plugin_props = props

    if( process.platform === 'linux' ) { // quick check if festival installed for linux
      process.env.PATH.replace(/["]+/g, '').split(path.delimiter).filter(Boolean).forEach((element) => {if(fs.existsSync(element+'/festival')) hasFestival=true})
      if (!hasFestival) app.error('Error: please install festival package')
    }
    if(plugin_props.mappings) plugin_props.mappings.forEach((m) => { if (typeof m.alarmAudioFileCustom != 'undefined') m.alarmAudioFile = m.alarmAudioFileCustom })
    subscribeToAlarms()
  }

  plugin.stop = function() {
    unsubscribes.forEach(function(func) { func() })
    unsubscribes = []
  }

  function subscription_error(err)
  {
    app.error('error: ' + err)
  }

  function got_delta(notification)
  {
    //app.debug('notification event: %o', notification)
    notification.updates.forEach(function(update) {
      update.values.forEach(function(value) {
        //app.debug('notification value: %o', value)
        if ( value.value != null
             && typeof value.value.state != 'undefined' )
        {
          if( typeof value.value.method != 'undefined'
            && value.value.method.indexOf('sound') != -1 )
          {
              let continuous = false
              let notice = false
              let custom_path = false
              let noPlay = false
              let audioFile = notificationSounds[value.value.state]

              if(plugin_props.mappings) plugin_props.mappings.forEach(function(notification) {   // check for custom notice
                if( value.path == notification.path && value.value.state == notification.state){
                  custom_path = true
                  if(notification.alarmAudioFile ) audioFile = notification.alarmAudioFile
                  if(notification.alarmType == 'continuous') continuous=true
                  else if(notification.alarmType == 'single notice' ) notice=true
                  if(notification.noPlay == true) noPlay=true
                }
              });

              if(!custom_path) {
                if( enableNotificationTypes[value.value.state] == 'continuous' )
                  continuous=true
                else if ( enableNotificationTypes[value.value.state] == 'single notice' )
                  notice=true
              }

              if ( notice || continuous )
              {
                let args = Object.create(soundEvent)
                args.audioFile = audioFile
                args.path=value.path
                args.state = value.value.state
                args.played = 0
                args.numNotifications = 0
                if (audioFile && !noPlay) args.numNotifications++
                else args.audioFile = ""
                if (value.value.message) { 
                  args.numNotifications++
                  args.message = value.value.message
                }
                if ( notice ){ args.mode = 'notice' }
                else if ( continuous ) { args.mode = 'continuous' }

                if(!last_states.get(value.path) || !last_states.get(value.path).state || 
                       last_states.get(value.path).state != args.state || last_states.get(value.path).message != args.message){
                        // only add if new path entry or if changing existing path's state (eg. alarm to alert) OR if messages changes
                  last_states.set(value.path, args)
                  app.debug('ADD2Q:'+args.path, args.mode, 'qSize:'+last_states.size)
                  if ( playing_sound == false ) {
                    play_event(args)
                  }
                }
              }
              else if ( last_states.has(value.path) )
              {
                if(last_states.get(value.path).played != true) {
                  last_states.get(value.path).mode = 'notice'
                } else
                  last_states.delete(value.path)
              }
          }
          else if ( last_states.has(value.path) )
          {
             if(last_states.get(value.path).played != true) {
               last_states.get(value.path).mode = 'notice'
             } else
               last_states.delete(value.path)
          }
        }
      })
    })
    //app.debug('Active: '+last_states.size)
    if ( last_states.size === 0 && playing_sound) { 
      stop_playing_queue()
    }
  }
    
  function stop_playing_queue()
  {
    app.debug('stop playing')
    playing_sound = false
    if (typeof playPID === 'number') process.kill(playPID)
    if ( plugin_props.postCommand && plugin_props.postCommand.length > 0 ) {
      const { exec } = require('node:child_process')
      app.debug('post command: %s', plugin_props.postCommand)
      exec(plugin_props.postCommand)
    } 
  }

  function play_event(soundEvent)
  {
    soundEvent.played++
    //app.debug("SOUND EVENT:",soundEvent)
    //soundEvent - path state audioFile message mode played numNotifications

    if ( notificationPrePost[soundEvent.state] ){
    //if ( soundEvent.mode == 'continuous') {
      if (  playing_sound != true && plugin_props.preCommand && plugin_props.preCommand.length > 0 ) { 
        const { exec } = require('node:child_process')
        app.debug('pre command: %s', plugin_props.preCommand)
        exec(plugin_props.preCommand)
      }
      playing_sound = true
    }

    if ( (soundEvent.message && soundEvent.played == 2) || (!soundEvent.audioFile && soundEvent.played == 1)){
      if( process.platform === "linux" && !hasFestival ) {
        app.debug('skipping saying:'+soundEvent.message,'mode:'+soundEvent.mode,"played:"+soundEvent.played)
        process_queue()
      }
      else {
        app.debug('saying:'+soundEvent.message,'mode:'+soundEvent.mode,"played:"+soundEvent.played)
        try {
          say.speak(soundEvent.message, null,null, (err) => { process_queue() })
        }
        catch(error) {
          app.debug("ERROR:"+error)
          process_queue()
        }
      }
    }
    else if ( soundEvent.audioFile ) {
      let command = plugin_props.alarmAudioPlayer
      sound_file = soundEvent.audioFile
  
      if ( sound_file && sound_file.charAt(0) != '/' )
      {
        sound_file = path.join(__dirname, "sounds", sound_file)
      }
      let args = [ sound_file ]
      if ( plugin_props.alarmAudioPlayerArguments && plugin_props.alarmAudioPlayerArguments.length > 0 ) {
        args = [ ...plugin_props.alarmAudioPlayerArguments.split(' '), ...args ]
      }
      app.debug('playing:'+soundEvent.audioFile,'mode:'+soundEvent.mode,"played:"+soundEvent.played)
      
      let play = child_process.spawn(command, args)
      playPID = play.pid
  
      play.on('error', (err) => {
        playPID = undefined
        app.error('failed to play sound ' + err)
      });
  
      play.on('close', (code) => {
        process_queue()
      });
    }
  }

  function process_queue() {
      //if ( code == 0 ) {
        playPID = undefined

        if ( last_states.size > 0 ) {
          if(queueIndex >= last_states.size) {queueIndex = 0}
          audioEvent = Array.from(last_states)[queueIndex][1]
          //app.debug(audioEvent)

          if(audioEvent.played < audioEvent.numNotifications) {
            play_event(audioEvent)
          }
          else {
            if(audioEvent.mode != 'continuous' ) {  // single play so delete
              last_states.delete(audioEvent.path)
            }
            else {     // continuous, so reset counter
              audioEvent.played = 0
            }
            queueIndex++   // next PATH if in queue
            if(queueIndex >= last_states.size) queueIndex = 0
            if(last_states.size > 0 ) { 
              play_event(Array.from(last_states)[queueIndex][1])
            }
            else {
              //muteMethod( audioEvent.path, "" )
              if(playing_sound) stop_playing_queue()
              app.debug("Queue Empty, waiting...")
            }
          }
        }
        else { 
          //muteMethod( audioEvent.path, "" )
          if(playing_sound) stop_playing_queue()
          app.debug("Queue Empty, waiting....")
        }
     // else {
     //   playPID = undefined
     // }
  }

  plugin.schema = function() {

    let defaultAudioPlayer = 'mpg321'
    if( process.platform === 'darwin' ) defaultAudioPlayer = 'afplay'
    let notificationTypes = ['continuous', 'single notice', 'mute']

    let schema = {
      type: 'object',
      description: 'Default Playback Method for Each (Emergency/Alarm/Warn/Alert) Notification Type:',
      required: [
        'enableEmergencies',
        'enableAlarms',
        'enableWarnings',
        'enableAlerts'
      ],
      properties: {
        enableEmergencies: {
          type: 'string',
          'enum': notificationTypes,
          title: ' # Emergency - Playback Method #',
          default: 'continuous'
        },
        emergencyAudioFile: {
          type: 'string',
          'enum': notificationFiles,
          title: 'Emergency - Notification Sound',
          default: notificationSounds.emergency
        },
        emergencyAudioFileCustom: {
          type: 'string',
          title: 'Emergency - Custom Notification Sound',
          description: 'Full Path to Sound File (overrides above setting)'
        },
        prePostEmergency: {
          type: 'boolean',
          title: 'Run Custom Pre/Post Commands for Emergency Notifications',
          default: true
        },

        enableAlarms: {
          type: 'string',
          'enum': notificationTypes,
          title: ' # Alarm - Playback Method #',
          default: 'continuous'
        },
        alarmAudioFile: {
          type: 'string',
          'enum': notificationFiles,
          title: 'Alarm - Notification Sound',
          default: notificationSounds.alarm
        },
        alarmAudioFileCustom: {
          type: 'string',
          title: 'Alarm - Custom Notification Sound',
          description: 'Full Path to Sound File (overrides above setting)'
        },
        prePostAlarm: {
          type: 'boolean',
          title: 'Run Custom Pre/Post Commands for Alarm Notifications',
          default: true
        },

        enableWarnings: {
          type: 'string',
          'enum': notificationTypes,
          title: ' # Warning - Playback Method #',
          default: 'single notice'
        },
        warnAudioFile: {
          type: 'string',
          'enum': notificationFiles,
          title: 'Warn - Notification Sound',
          default: notificationSounds.warn
        },
        warnAudioFileCustom: {
          type: 'string',
          title: 'Warn - Custom Notification Sound',
          description: 'Full Path to Sound File (overrides above setting)'
        },
        prePostWarn: {
          type: 'boolean',
          title: 'Run Custom Pre/Post Commands for Warn Notifications',
          default: false
        },

        enableAlerts: {
          type: 'string',
          'enum': notificationTypes,
          title: ' # Alert - Playback Method #',
          default: 'single notice'
        },
        alertAudioFile: {
          type: 'string',
          'enum': notificationFiles,
          title: 'Alert - Notification Sound',
          default: notificationSounds.alert
        },
        alertAudioFileCustom: {
          type: 'string',
          title: 'Alert - Custom Notification Sound',
          description: 'Full Path to Sound File (overrides above setting)'
        },
        prePostAlert: {
          type: 'boolean',
          title: 'Run Custom Pre/Post Commands for Alert Notifications',
          default: false
        },

        preCommand: {
          title: 'Custom Command Before Playing Notification',
          description: 'optional command to run before playing/speaking',
          type: 'string'
        },
        postCommand: {
          title: 'Custom Command After Playing Notification',
          description: 'optional command to run after playing/speaking',
          type: 'string'
        },
        alarmAudioPlayer: {
          title: 'Audio Player',
          description: 'Select command line audio player',
          type: 'string',
          default: defaultAudioPlayer,
          'enum': ['afplay', 'omxplayer', 'mpg321', 'mpg123']
        },
        alarmAudioPlayerArguments: {
          title: 'Audio Player Arguments',
          description: 'Arguments to add to the audio player command',
          type: 'string'
        },
        mappings: {
          type: 'array',
          title: 'Custom Action For Specific Notifications',
          items: {
            type: 'object',
            required: ['path'],
            properties: {
              path: {
                type: 'string',
                title: 'Notification Path'
              },
              state: {
                type: 'string',
                'enum': ['emergency', 'alarm', 'warn', 'alert', 'normal', 'nominal'],
                title: 'Notification State',
                description: '(Notification Path can be assigned a custom action for each Notification State)',
                default: 'emergency'
              },
              alarmType: {
                type: 'string',
                'enum': notificationTypes,
                title: 'Playback Method',
                default: 'single notice'
              },
/*              methodMute: {
                type: 'boolean',
                title: 'For - Single Notice - Notification Types Only - Silences Notification Method after Playing Once',
                description: 'Clears Notification Sound Method (eg. silent/mute) so other apps don\'t repeat',
                default: false
              },
*/
              alarmAudioFile: {
                type: 'string',
                'enum': notificationFiles,
                title: 'Playback Sound',
                default: notificationSounds.emergency
              },
              alarmAudioFileCustom: {
                type: 'string',
                title: 'Custom Playback Sound',
                description: 'Full Path to Sound File (overrides above setting)'
              },
              noPlay: {
                type: 'boolean',
                title: 'Do Not Play Notification Sound',
                description: 'Only Speak/Say Notification Message',
                default: false
              }
            }
          }
        }
      }
    }
    //if(typeof alarmAudioFileCustom !== 'undefined') alarmAudioFile = alarmAudioFileCustom
    //if(typeof warnAudioFileCustom !== 'undefined') warnAudioFile = warnAudioFileCustom

    if(typeof plugin_props !== 'undefined' ) {
      enableNotificationTypes.emergency = plugin_props.enableEmergencies
      enableNotificationTypes.alarm = plugin_props.enableAlarms
      enableNotificationTypes.warn = plugin_props.enableWarnings
      enableNotificationTypes.alert = plugin_props.enableAlerts
  
      notificationPrePost.emergency = plugin_props.prePostEmergency
      notificationPrePost.alarm = plugin_props.prePostAlarm
      notificationPrePost.warn = plugin_props.prePostWarn
      notificationPrePost.alert = plugin_props.prePostAlert
  
      if(plugin_props.emergencyAudioFileCustom) notificationSounds.emergency = plugin_props.emergencyAudioFileCustom
      else if (plugin_props.emergencyAudioFile) notificationSounds.emergency = plugin_props.emergencyAudioFile
      if(plugin_props.alarmAudioFileCustom) notificationSounds.alarm = plugin_props.alarmAudioFileCustom
      else if (plugin_props.alarmAudioFile) notificationSounds.alarm = plugin_props.alarmAudioFile
      if(plugin_props.warnAudioFileCustom) notificationSounds.warn = plugin_props.warnAudioFileCustom
      else if (plugin_props.warnAudioFile) notificationSounds.warn = plugin_props.warnAudioFile
      if(plugin_props.alertAudioFileCustom) notificationSounds.alert = plugin_props.alertAudioFileCustom
      else if (plugin_props.alertAudioFile) notificationSounds.alert = plugin_props.alertAudioFile
    }

    return schema
  }

/*
  function muteMethod( path, value ) {
    app.handleMessage('self.notificationhandler', {
      updates: [
        {
          values: [
            {
              path: "notifications.electrical.batteries.bmv.relay",
              method: []
            }
          ],
          $source: 'self.notificationhandler'
        }
      ]
    })
  }
*/

  function subscribeToAlarms()
  {
    const command = {
      context: 'vessels.self',
      subscribe: [{
        path: 'notifications.*',
        policy: 'instant'
      }]
    } 
    app.subscriptionmanager.subscribe(command, unsubscribes, subscription_error, got_delta)
  }

  return plugin;
}
