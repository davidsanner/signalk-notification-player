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
const fspath = require('path')
const child_process = require('child_process')
const say = require('say');
const SlackNotify = require('slack-notify')

module.exports = function(app) {
  var plugin = {}
  plugin.id = 'signalk-notification-player'
  plugin.name = 'Notification Player'
  plugin.description = 'Plugin that plays notification sounds/speech'
 
  var unsubscribes = []
  var queueActive = false
  var pluginProps
  var alertQueue = new Map()
  var alertLog = new Map()
  var lastAlert = ''
  var playPID
  var queueIndex = 0
  var muteUntil = 0
  var hasFestival = false
  var repeatGapDefault = 0  // no repeat rate control
  var vesselName
  var notificationFiles = ['builtin_alarm.mp3', 'builtin_notice.mp3', 'builtin_sonar.mp3', 'builtin_tritone.mp3']
  var notificationSounds = {'emergency': notificationFiles[0], 'alarm': notificationFiles[1], 'warn': notificationFiles[2], 'alert': notificationFiles[3]}
  var enableNotificationTypes = {'emergency': 'continuous', 'alarm': 'continuous', 'warn': 'single notice', 'alert': 'single notice'}
  var notificationPrePost = {'emergency': true, 'alarm': true, 'warn': true, 'alert': false}
  const soundEvent = { path: '', state: '', audioFile: '', message: '', mode: '', played: 0, numNotifications: 0}
  const soundEventLog = { message: '', timestamp: 0}

  plugin.start = function(props) {
    pluginProps = props
    if ( !pluginProps.repeatGap ) pluginProps.repeatGap = repeatGapDefault

    if( process.platform === 'linux' ) { // quick check if festival installed for linux
      process.env.PATH.replace(/["]+/g, '').split(fspath.delimiter).filter(Boolean).forEach((element) => {if(fs.existsSync(element+'/festival')) hasFestival=true})
      if (!hasFestival) app.error('Error: please install festival package')
    }
    if(pluginProps.mappings) pluginProps.mappings.forEach((m) => { if (typeof m.alarmAudioFileCustom != 'undefined') m.alarmAudioFile = m.alarmAudioFileCustom })
    if ( !(vesselName=app.getSelfPath('name')) ) vesselName = "Unnamed"
    if(!pluginProps.playbackControlPrefix) pluginProps.playbackControlPrefix = 'digital.notificationPlayer'

    subscribeToNotifications()
    subscribeToHandlers()
  }
  plugin.stop = function() {
    unsubscribes.forEach(function(func) { func() })
    unsubscribes = []
  }
  function subscriptionError(err) {
    app.error('error: ' + err)
  }

  function processNotifications(fullNotification) {
    fullNotification.updates.forEach(function(update) {
      update.values.forEach(function(notifcation) {  // loop for each notification update
        nPath = notifcation.path ; value = notifcation.value
        //if(value.state != 'normal' ) app.debug('notification path:', nPath, 'value:', value)   // value.nPath & value.value 
        //app.debug('notification path:', nPath, 'value:', value)   // value.nPath & value.value 

        if ( value != null && typeof value.state != 'undefined' ) {
          if( typeof value.method != 'undefined' && value.method.indexOf('sound') != -1 ) {
              let continuous = false
              let notice = false
              let noPlay = false
              let msgServiceAlert = false
              let audioFile = notificationSounds[value.state]
              let repeatGap = pluginProps.repeatGap

              ppm = pluginProps.mappings   // // check for custom notice & configure if found
              if( pluginProps.mappings && nPath && value.state &&
                (notification = pluginProps.mappings.find(ppm => ppm.path === nPath && ppm.state === value.state ) )) { 
                //app.debug("Found custom notification", notification )
                if(notification.alarmAudioFile ) audioFile = notification.alarmAudioFile
                if(notification.alarmType == 'continuous') continuous=true
                else if(notification.alarmType == 'single notice' ) notice=true
                if(notification.noPlay == true) noPlay=true
                if(notification.repeatGap) repeatGap=notification.repeatGap
                if(notification.msgServiceAlert) msgServiceAlert=true
              } else {
                if( enableNotificationTypes[value.state] == 'continuous' )
                  continuous=true
                else if ( enableNotificationTypes[value.state] == 'single notice' )
                  notice=true
              }

              let eventTimeStamp = new Date(update.timestamp).getTime()
                    // Has notification type, otherwise delete from Q and only add if new path entry or if changing existing path's state (eg. alarm to alert) 
                    // and if messages changes && not bouncing/recent (except alarm & emergency)
              if ( ( notice || continuous ) && (!alertQueue.get(nPath) || !alertQueue.get(nPath).state ||
                     alertQueue.get(nPath).state != value.state || alertQueue.get(nPath).message != value.message) 
                    && (!alertLog.get(nPath+"."+value.state) || (alertLog.get(nPath+"."+value.state).timestamp + (repeatGap * 1000)) < eventTimeStamp ||
                         value.state == 'emergency' || value.state == 'alarm') ) {
                let args = Object.create(soundEvent)
                args.audioFile = audioFile
                args.path=nPath
                args.state = value.state
                args.played = 0
                args.numNotifications = 0
                if (audioFile && !noPlay) args.numNotifications++
                else args.audioFile = ""
                if (value.message) { 
                  args.numNotifications++
                  args.message = value.message
                }
                if ( notice ){ args.mode = 'notice' }
                else if ( continuous ) { args.mode = 'continuous' }

                alertQueue.set(nPath, args)
                lastAlert = args.path+"."+args.state
                alertLog.set(args.path+"."+args.state, { message: args.message, timestamp: eventTimeStamp})
                app.debug('ADD2Q:'+args.path, args.mode, args.state, 'qSize:'+alertQueue.size)
                if ( !queueActive && ( !muteUntil || muteUntil <= now() ) ) {  // check for now() is just safety bug catch
                  queueActive = true
                  processQueue()  //playEvent(args)
                }
                if ( msgServiceAlert && pluginProps.slackWebhookURL != null) {
                  app.debug("Slack Message:",args.path,args.message)
                  SlackNotify(pluginProps.slackWebhookURL).send({
                    channel: pluginProps.slackChannel,
                    text: vesselName+": "+args.message,
                    fields: {
                      'SignalK Notification': args.path+" / "+args.state,
                      'Message': args.message+" @ "+ new Date(eventTimeStamp).toISOString(),
                      'Value': app.getSelfPath(args.path.substring(args.path.indexOf(".") + 1)+'.value')
                    }
                  })
                }
              }
              else if ( alertQueue.has(nPath) ) {  // resolved: state's notificationType has no continuous or single notice method, typical back to normal state
                if(alertQueue.get(nPath).played != true) { // try and play at least once but if cleared then only once
                  alertQueue.get(nPath).mode = 'notice'
                } else
                  alertQueue.delete(nPath)  // no continuous or single notice method for this state so delete
              }
          }
          else if ( alertQueue.has(nPath) )  { // silenced: no method or sound method value
             if(alertQueue.get(nPath).played != true) { // try and play at least once but if cleared then only once
               alertQueue.get(nPath).mode = 'notice'
             } else
               alertQueue.delete(nPath)
          }
        }
      })  //  end loop for each notification update
    })
    if ( alertQueue.size === 0 && queueActive) { 
      stopProcessingQueue()
    }
  }
    
  function stopProcessingQueue()
  {
    //app.debug('stop playing')
    queueActive = false
    if (typeof playPID === 'number') process.kill(playPID)
    if ( pluginProps.postCommand && pluginProps.postCommand.length > 0 ) {
      const { exec } = require('node:child_process')
      app.debug('post-command: %s', pluginProps.postCommand)
      exec(pluginProps.postCommand)
    } 
  }

  function playEvent(soundEvent)
  {
    soundEvent.played++
    //app.debug("SOUND EVENT:",soundEvent)
    //soundEvent object: path state audioFile message mode played numNotifications

    if ( notificationPrePost[soundEvent.state] ){
    //if ( soundEvent.mode == 'continuous') {
      if (  queueActive != true && pluginProps.preCommand && pluginProps.preCommand.length > 0 ) { 
        const { exec } = require('node:child_process')
        app.debug('pre-command: %s', pluginProps.preCommand)
        exec(pluginProps.preCommand)
      }
      queueActive = true
    }
    if ( (soundEvent.message && soundEvent.played == 2) || (!soundEvent.audioFile && soundEvent.played == 1)){
      if( process.platform === "linux" && !hasFestival ) {
        app.debug('skipping saying:'+soundEvent.message,'mode:'+soundEvent.mode,"played:"+soundEvent.played)
        processQueue()
      }
      else {
        app.debug('saying:'+soundEvent.message,'mode:'+soundEvent.mode,"played:"+soundEvent.played)
        try {
          say.speak(soundEvent.message, null,null, (err) => { processQueue() })
        }
        catch(error) {
          app.debug("ERROR:"+error)
          processQueue()
        }
      }
    }
    else if ( soundEvent.audioFile ) {
      let command = pluginProps.alarmAudioPlayer
      soundFile = soundEvent.audioFile
  
      if ( soundFile && soundFile.charAt(0) != '/' )
      {
        soundFile = fspath.join(__dirname, "sounds", soundFile)
      }
      if ( fs.existsSync(soundFile) ) {
        let args = [ soundFile ]
        if ( pluginProps.alarmAudioPlayerArguments && pluginProps.alarmAudioPlayerArguments.length > 0 ) {
          args = [ ...pluginProps.alarmAudioPlayerArguments.split(' '), ...args ]
        }
        app.debug('playing:'+soundEvent.audioFile,'mode:'+soundEvent.mode,"played:"+soundEvent.played)

        let play = child_process.spawn(command, args)
        playPID = play.pid

        play.on('error', (err) => {
          playPID = undefined
          app.error('failed to play sound ' + err)
          processQueue()
        });

        play.on('close', (code) => {
          processQueue()
        });
      }
      else {
        app.debug('not playing, sound file missing:'+soundFile)
        processQueue()
      }
    }
  }

  function processQueue() {
      //if ( code == 0 ) {
        playPID = undefined

        if ( muteUntil ) {
            app.debug( "Muted in processQueue to", muteUntil)   // should we ever be here?
        }
        else if ( alertQueue.size > 0 ) {
          if(queueIndex >= alertQueue.size) {queueIndex = 0}
          audioEvent = Array.from(alertQueue)[queueIndex][1]
          //app.debug(audioEvent)

          if(audioEvent.played < audioEvent.numNotifications) {
            playEvent(audioEvent)
          }
          else {
            if(audioEvent.mode != 'continuous' ) {  // single play so delete
              alertQueue.delete(audioEvent.path)
            }
            else {     // continuous, so reset counter
              audioEvent.played = 0
            }
            queueIndex++   // next PATH if in queue
            if(queueIndex >= alertQueue.size) queueIndex = 0
            if(alertQueue.size > 0 ) { 
              playEvent(Array.from(alertQueue)[queueIndex][1])
            }
            else {
              //muteMethod( audioEvent.path, "" )
              if(queueActive) stopProcessingQueue()
              app.debug("Queue Empty, waiting...")
            }
          }
        }
        else { 
          //muteMethod( audioEvent.path, "" )
          if(queueActive) stopProcessingQueue()
          app.debug("Queue Empty, waiting ...")
        }
  }

  function now() {  return Math.floor(Date.now()) } 

  function delay(time) { return new Promise(resolve => setTimeout(resolve, time)); }

  plugin.schema = function() {

    let defaultAudioPlayer = 'mpg321'
    if( process.platform === 'darwin' ) defaultAudioPlayer = 'afplay'
    let notificationTypes = ['continuous', 'single notice', '-PLAYBACK DISABLED-']

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
        t1: {
          type: "object",
          title: "Emergencies Notification Settings"
        },
        enableEmergencies: {
          type: 'string',
          'enum': notificationTypes,
          title: 'Emergency - Playback Method',
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

        t2: {
          type: "object",
          title: "Alarm Notification Settings"
        },
        enableAlarms: {
          type: 'string',
          'enum': notificationTypes,
          title: 'Alarm - Playback Method',
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

        t3: {
          type: "object",
          title: "Warning Notification Settings"
        },
        enableWarnings: {
          type: 'string',
          'enum': notificationTypes,
          title: 'Warning - Playback Method',
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

        t4: {
          type: "object",
          title: "Alert Notification Settings"
        },
        enableAlerts: {
          type: 'string',
          'enum': notificationTypes,
          title: 'Alert - Playback Method',
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

        t5: {
          type: "object",
          title: "General Settings"
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
        repeatGap: {
          title: 'Minimum Gap Between Duplicate Notifications',
          description: 'Limit rate of notifications when bouncing in/out of a zone (seconds), except emergency & alarm',
          type: 'number',
          default: repeatGapDefault
        },
        playbackControlPrefix: {
          type: 'string',
          title: 'Signal K path prefix for playback control',
          default: 'digital.notificationPlayer',
          description: 'Silence and resolve notification via SK paths (eg. digital.notificationPlayer + .silence .resolve .disable)'
        },
        slackWebhookURL: {
          type: 'string',
          title: 'Slack Webhook URL',
          description: 'Optional Slack messaging for Custom Actions (See: https://api.slack.com/messaging/webhooks)'
        },
        slackChannel: {
          type: 'string',
          title: 'Slack channel',
          default: '#signalk'
        },

        mappings: {
          type: 'array',
          title: 'Custom Actions For Specific Notifications',
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
              },
              repeatGap: {
                title: 'Minimum Gap Between Duplicate Notifications',
                description: 'Limit rate of notifications when bouncing in/out of this zone (seconds), ignored for emergency & alarm',
                type: 'number'
              },
              msgServiceAlert: {
                type: 'boolean',
                title: 'Send Notification via Slack',
                description: 'Send notifcation to Slack channel (if Webhook URL configured above)',
                default: false
              },
            }
          }
        }
      }
    }

    if(typeof pluginProps !== 'undefined' ) {
      enableNotificationTypes.emergency = pluginProps.enableEmergencies
      enableNotificationTypes.alarm = pluginProps.enableAlarms
      enableNotificationTypes.warn = pluginProps.enableWarnings
      enableNotificationTypes.alert = pluginProps.enableAlerts
  
      notificationPrePost.emergency = pluginProps.prePostEmergency
      notificationPrePost.alarm = pluginProps.prePostAlarm
      notificationPrePost.warn = pluginProps.prePostWarn
      notificationPrePost.alert = pluginProps.prePostAlert
  
      if(pluginProps.emergencyAudioFileCustom) notificationSounds.emergency = pluginProps.emergencyAudioFileCustom
      else if (pluginProps.emergencyAudioFile) notificationSounds.emergency = pluginProps.emergencyAudioFile
      if(pluginProps.alarmAudioFileCustom) notificationSounds.alarm = pluginProps.alarmAudioFileCustom
      else if (pluginProps.alarmAudioFile) notificationSounds.alarm = pluginProps.alarmAudioFile
      if(pluginProps.warnAudioFileCustom) notificationSounds.warn = pluginProps.warnAudioFileCustom
      else if (pluginProps.warnAudioFile) notificationSounds.warn = pluginProps.warnAudioFile
      if(pluginProps.alertAudioFileCustom) notificationSounds.alert = pluginProps.alertAudioFileCustom
      else if (pluginProps.alertAudioFile) notificationSounds.alert = pluginProps.alertAudioFile
    }
    return schema
  }

  function subscribeToHandlers()
  {
    app.handleMessage(plugin.id, { updates: [ { values: [ { path: pluginProps.playbackControlPrefix+'.disable', value: false } ] } ] })
    app.registerPutHandler('vessels.self', pluginProps.playbackControlPrefix+'.disable', handleDisable);
    app.handleMessage(plugin.id, { updates: [ { values: [ { path: pluginProps.playbackControlPrefix+'.silence', value: false } ] } ] })
    app.registerPutHandler('vessels.self', pluginProps.playbackControlPrefix+'.silence', handleSilence);
    app.handleMessage(plugin.id, { updates: [ { values: [ { path: pluginProps.playbackControlPrefix+'.resolve', value: false } ] } ] })
    app.registerPutHandler('vessels.self', pluginProps.playbackControlPrefix+'.resolve', handleResolve);
    //app.handleMessage(plugin.id, { updates: [ { values: [ { path: 'digital.notificationPlayer.ignoreLast', value: false } ] } ] })
    //app.registerPutHandler('vessels.self', 'digital.notificationPlayer.ignoreLast', handleIgnoreLast);
  }

  function subscribeToNotifications()
  {
    const command = {
      context: 'vessels.self',
      subscribe: [{
        path: 'notifications.*',
        policy: 'instant'
      }]
    } 
    app.subscriptionmanager.subscribe(command, unsubscribes, subscriptionError, processNotifications)
  }

////

  function silenceNotifications() {
    for (let [key, value] of  alertQueue.entries()) {
      app.debug("Silencing PATH:", key)
      const nvalue = app.getSelfPath(key);
      const nmethod = nvalue.value.method.filter(item => item !== 'sound')
      const delta = {
        updates: [{ 
          values: [{
            path: key,
              value: {
                state: nvalue.value.state,
                method: nmethod,
                message: nvalue.value.message
             }
          }], 
          $source: nvalue.$source,
        }]
      }
      app.handleMessage(plugin.id, delta)
    }
  }

  function resolveNotifications() {
    app.debug("Resolve Notifcations")
    for (let [key, value] of alertLog.entries()) {  // check log for any alert played including ones silenced (currently not in alertQueue)
      key = key.substring(0,key.lastIndexOf("."))
      const nvalue = app.getSelfPath(key)
      if( nvalue.value.state != 'normal' && nvalue.value.state != 'nominal'  ) { // only clear -> set-to-normal elevated notification states
        app.debug("Resolve Clearing:", key)
        const delta = {
          updates: [{ 
            values: [{
              path: key,
              value: {
                state: 'normal',
                method: nvalue.value.method,
                message: nvalue.value.message
              }
            }], 
            $source: nvalue.$source,
          }]
        }
        app.handleMessage(plugin.id, delta)
      }
    }
  }

////

  function handleDisable(context, path, value, callback) {
    //app.debug("handleDisable", context, path, value)
    if( value == true ) {
      //if( muteUntil == 0 )
      if((muteUntil - (3600 * 1000)) < ( now() - 1000 )) {  // bounce check, accept at max 1hz rate
        muteUntil = now() + (3600 * 1000)  // 1hr max
        app.debug("Disabling in handleDisable", value)
        app.handleMessage(plugin.id, { updates: [ { values: [ { path: 'digital.notificationPlayer.disable', value: value } ] } ] })
        //muteUntil = now() + (300 * 1000)   // 5 minutes
  
        delay( 3600 * 1000 ).then(() => {
          if ( muteUntil <= now() &&  muteUntil != 0 ) {  // check if later timer set and if not already cleared
            app.debug("Enabling in handleDisable via timeout")
            muteUntil = 0
            app.handleMessage(plugin.id, { updates: [ { values: [ { path: 'digital.notificationPlayer.disable', value: false } ] } ] })
            processQueue()
          }
        })
      }
    } else {
      app.debug("Enabling in handleDisable", value)
      muteUntil = 0
      app.handleMessage(plugin.id, { updates: [ { values: [ { path: 'digital.notificationPlayer.disable', value: false } ] } ] })
      processQueue()
    }
    return { state: 'COMPLETED', statusCode: 200 };
  }
  function handleSilence(context, path, value, callback) {
    silenceNotifications()
    return { state: 'COMPLETED', statusCode: 200 };
  }
  function handleResolve(context, path, value, callback) {
    resolveNotifications()
    return { state: 'COMPLETED', statusCode: 200 };
  }
/*
  function handleIgnoreLast(context, path, value, callback) {
      if(!lastAlert) { return { state: 'COMPLETED', statusCode: 200 } }
      if( laVal = alertLog.get(lastAlert) ) {
        laVal.timestamp = now() + ( 1200 * 1000 )   // 20 minutes
        alertLog.set(lastAlert, laVal)   // set lastAlert time in the future to silence it until then
        alertQueue.delete(lastAlert.substr(0, lastAlert.lastIndexOf(".")))   // clear active Q entry / any type
      }
      return { state: 'COMPLETED', statusCode: 200 };
  }
*/

////

  plugin.registerWithRouter = (router) => {
    router.get("/silence", (req, res) => {
      silenceNotifications()
      res.send("Active Notifications Silenced")
    })
    router.get("/resolve", (req, res) => {
      resolveNotifications()
      res.send("Active Notifications Resolved")
    })
    router.get("/disable", (req, res) => {
      var muteTime = parseInt(req._parsedUrl.query)
      if ( isNaN(muteTime) ) { muteTime = 3600 }   // default 3600 seconds
      if (muteTime > 28800) { 
        muteTime = 18800 // max 8hr disable
        res.send("Disable playback for "+muteTime+" seconds, maxmium allowed.")
      } else {
        res.send("Disable playback for "+muteTime+" seconds")
      }
      app.debug("Disable playback for next", muteTime, "seconds")
      muteUntil = now() + (muteTime * 1000)
      app.handleMessage(plugin.id, { updates: [ { values: [ { path: 'digital.notificationPlayer.disable', value: true } ] } ] })
      delay( muteTime * 1000 ).then(() => {
        if ( muteUntil <= now() &&  muteUntil != 0 ) {  // check if later timer set and if not already cleared
          app.debug("Enable in get/disable")
          app.handleMessage(plugin.id, { updates: [ { values: [ { path: 'digital.notificationPlayer.disable', value: false } ] } ] })
          muteUntil = 0
          processQueue()
        }
      })
    })
/*
    router.get("/ignoreLast", (req, res) => {
      if(!lastAlert) { res.send("No alerts to mute.") ; return }
      var muteTime = parseInt(req._parsedUrl.query)
      if ( isNaN(muteTime) ) { muteTime = 600 }   // default 600 seconds
      if (muteTime > 3600) {  // max 1hr
        muteTime = 3600
        res.send("Muting "+lastAlert+ " playback for "+muteTime+" seconds, maxmium allowed.")
      } else {
        res.send("Muting "+lastAlert+ " playback for "+muteTime+" seconds")
      }
      if( laVal = alertLog.get(lastAlert) ) {
        laVal.timestamp = now() + ( muteTime * 1000 )
        alertLog.set(lastAlert, laVal)   // set lastAlert time in the future to silence it until then
        alertQueue.delete(lastAlert.substr(0, lastAlert.lastIndexOf(".")))   // clear active Q entry / any type
      }
      app.debug("Muting PB for", lastAlert, "next", muteTime, "seconds")
      //for (type in enableNotificationTypes) { app.debug(type) }
      //app.debug("alertLog:", alertLog) ; //app.debug("alertQueue:", alertQueue)
    })
*/
  } // end registerWithRouter()

  return plugin;

}

// END //
