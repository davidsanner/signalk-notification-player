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
  var enableNotificationTypes = []
  var playPID
  var queueIndex = 0
  var hasFestival = false
  const soundEvent = { path: '', state: '', audioFile: '', message: '', mode: '', played: 0, numNotifications: 0}

  plugin.start = function(props) {
    plugin_props = props
    enableNotificationTypes['emergency'] = plugin_props.enableEmergencies
    enableNotificationTypes['alarm'] = plugin_props.enableAlarms
    enableNotificationTypes['warn'] = plugin_props.enableWarnings
    enableNotificationTypes['alert'] = plugin_props.enableAlerts

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
              let audioFile = undefined


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
                Object.keys(enableNotificationTypes).forEach(function(ntype) {
                  if ([ntype].indexOf(value.value.state) != -1 && enableNotificationTypes[ntype] == 'continuous') {
                    continuous=true
                    audioFile = plugin_props.alarmAudioFile
                  } if ([ntype].indexOf(value.value.state) != -1 && enableNotificationTypes[ntype] == 'single notice') {
                    notice=true
                    audioFile = plugin_props.warnAudioFile
                  }
                }); 
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

                if(!last_states.get(value.path) || !last_states.get(value.path).state || last_states.get(value.path).state != args.state){
                        // only add if new path entry or if changing existing path's state (eg. alarm to alert)
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

    if ( soundEvent.mode == 'continuous') {
      if (  playing_sound != true && plugin_props.preCommand && plugin_props.preCommand.length > 0 ) { 
        const { exec } = require('node:child_process')
        app.debug('pre command: %s', plugin_props.preCommand)
        exec(plugin_props.preCommand)
      }
    }

    playing_sound = true
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
                  stop_playing_queue()
                  app.debug("Queue Empty, waiting...")
            }
          }
        }
        else {  // event removed in got_delta
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
    let notificationFiles = ['builtin_alarm.mp3', 'builtin_notice.mp3', 'builtin_sonar.mp3']

    let schema = {
      title: 'Notification Player',
      description: 'Default Response for Each (4) Notification Type:',
      type: 'object',
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
          title: 'Emergency Notification Type',
          default: 'continuous'
        },
        enableAlarms: {
          type: 'string',
          'enum': notificationTypes,
          title: 'Alarm Notification Type',
          default: 'continuous'
        },
        enableWarnings: {
          type: 'string',
          'enum': notificationTypes,
          title: 'Warning Notification Type',
          default: 'single notice'
        },
        enableAlerts: {
          type: 'string',
          'enum': notificationTypes,
          title: 'Alert Notification Type',
          default: 'single notice'
        },
        alarmAudioFile: {
          type: 'string',
          'enum': notificationFiles,
          title: 'Notification sound for continuous audio notification',
          default: notificationFiles[0]
        },
        alarmAudioFileCustom: {
          type: 'string',
          title: 'Custom notification for continuous - full path to sound file (overrides above setting)'
        },
        warnAudioFile: {
          type: 'string',
          'enum': notificationFiles,
          title: 'Notification sound for single notice audio notification',
          default: notificationFiles[1]
        },
        warnAudioFileCustom: {
          type: 'string',
          title: 'Custom notification for single notice',
          description: 'Full Path to Sound File (overrides above setting)'
        },
        preCommand: {
          title: 'Command before playing alarm/emergency',
          description: 'optional command to run before playing alarm or emergency',
          type: 'string'
        },
        postCommand: {
          title: 'Command after playing alarm/emergency',
          description: 'optional command to run after alarm or emergency is cleared',
          type: 'string'
        },
        alarmAudioPlayer: {
          title: 'Audio Player',
          description: 'Select command line audio player',
          type: 'string',
          default: defaultAudioPlayer,
          'enum': ['afplay', 'omxplayer', 'mpg321']
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
            required: ['path', 'alarmType','state'],
            properties: {
              path: {
                type: 'string',
                title: 'Notification Path'
              },
              state: {
                type: 'string',
                'enum': ['emergency', 'alarm', 'warn', 'alert', 'normal'],
                title: 'Notification State',
                description: '(Notification Path can be assigned a custom action for each Notification State',
                default: 'emergency'
              },
              alarmType: {
                type: 'string',
                'enum': notificationTypes,
                title: 'Notification Type',
                default: 'single notice'
              },
              alarmAudioFile: {
                type: 'string',
                'enum': notificationFiles,
                title: 'Notification Sound',
                default: notificationFiles[0]
              },
              alarmAudioFileCustom: {
                type: 'string',
                title: 'Custom Notification Sound',
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
    if(typeof alarmAudioFileCustom !== 'undefined') alarmAudioFile = alarmAudioFileCustom
    if(typeof warnAudioFileCustom !== 'undefined') warnAudioFile = warnAudioFileCustom
    return schema
  }

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
