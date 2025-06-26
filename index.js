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
const say = require('say')
const SlackNotify = require('slack-notify')

module.exports = function (app) {
  var plugin = {}
  plugin.id = 'signalk-notification-player'
  plugin.name = 'Notification Player'
  plugin.description = 'Plugin that plays notification sounds/speech'

  const maxDisable = 3600 // max disable all time in seconds
  const playBackTimeOut = 60000 // 60s failsafe override playBack
  var unsubscribes = []
  var queueActive = false // keeps track of running the preCommand
  var playBackActive = false
  var hasFestival = false
  var pluginProps
  var lastAlert = ''
  var playPID
  var queueIndex = 0
  var muteUntil = 0
  var vesselName
  var listFile, logFile
  var alertQueue = new Map()
  var alertLog = {} // used to keep track of recent alerts to control bouncing in/out of zone
  var notificationList = {} // notification state, disabled setting saved to disk
  var notificationLog = [] // long term timestamped log for every notification event

  const notificationFiles = ['builtin_alarm.mp3', 'builtin_notice.mp3', 'builtin_sonar.mp3', 'builtin_tritone.mp3']
  var notificationSounds = { emergency: notificationFiles[0], alarm: notificationFiles[1], warn: notificationFiles[2], alert: notificationFiles[3] }
  var enableNotificationTypes = { emergency: 'continuous', alarm: 'continuous', warn: 'single notice', alert: 'single notice' }
  var notificationPrePost = { emergency: true, alarm: true, warn: true, alert: false }
  const soundEvent = { path: '', state: '', audioFile: '', message: '', mode: '', played: 0, numNotifications: 0, playAfter: 0, disabled: false }

  plugin.start = function (props) {
    pluginProps = props

    if (!pluginProps.repeatGap) pluginProps.repeatGap = 0

    if (process.platform === 'linux') {
      // quick check if festival installed for linux
      process.env.PATH.replace(/["]+/g, '')
        .split(fspath.delimiter)
        .filter(Boolean)
        .forEach((element) => {
          if (fs.existsSync(element + '/festival')) hasFestival = true
        })
      if (!hasFestival) app.error('Error: please install festival package')
    }
    if (pluginProps.mappings)
      pluginProps.mappings.forEach((m) => {
        if (typeof m.alarmAudioFileCustom != 'undefined') m.alarmAudioFile = m.alarmAudioFileCustom
      })
    if (!(vesselName = app.getSelfPath('name'))) vesselName = 'Unnamed'
    if (!pluginProps.playbackControlPrefix) pluginProps.playbackControlPrefix = 'digital.notificationPlayer'

    listFile = fspath.join(app.getDataDirPath(), 'notificationList.json')
    readListFile(listFile)
    logFile = fspath.join(app.getDataDirPath(), 'notificationLog.json')
    readLogFile(logFile)

    //const openapi = require('./openApi.json'); plugin.getOpenApi = () => openapi
    subscribeToNotifications()
    delay(4000).then(() => {
      // also startup of SK so wait for things to settle and then check we did't miss any notifications
      findObjectsEndingWith(app.getSelfPath('notifications'), 'value').forEach(function (update) {
        // load notificationList
        update.path = 'notifications.' + update.path
        processNotifications({ updates: [{ values: [update] }] })
      })
    })
    subscribeToHandlers()
  }
  plugin.stop = function () {
    unsubscribes.forEach(function (func) {
      func()
    })
    unsubscribes = []
  }
  function subscriptionError(err) {
    app.error('error: ' + err)
  }

  ////

  function processNotifications(fullNotification) {
    fullNotification.updates.forEach(function (update) {
      update.values.forEach(function (notifcation) {
        // loop for each notification update
        nPath = notifcation.path
        value = notifcation.value
        //if(value.state != 'normal' ) app.debug('notification path:', nPath, 'value:', value)   // value.nPath & value.value
        //app.debug('notification path:', nPath, 'value:', value)   // value.nPath & value.value

        if (value != null && typeof value.state != 'undefined') {
          if (typeof notificationList[nPath] != 'undefined')
            notificationList[nPath] = { state: value.state, disabled: notificationList[nPath].disabled }
          else notificationList[nPath] = { state: value.state, disabled: false }
          if (typeof value.method != 'undefined' && value.method.indexOf('sound') != -1) {
            let continuous = false
            let notice = false
            let noPlay = false
            let msgServiceAlert = false
            let playAfter = 0
            let audioFile = notificationSounds[value.state]
            let repeatGap = pluginProps.repeatGap

            ppm = pluginProps.mappings // // check for custom notice & configure if found
            if (
              pluginProps.mappings &&
              nPath &&
              value.state &&
              (notification = pluginProps.mappings.find((ppm) => ppm.path === nPath && ppm.state === value.state))
            ) {
              //app.debug('Found custom notification', notification )
              if (notification.alarmAudioFile) audioFile = notification.alarmAudioFile
              if (notification.alarmType == 'continuous') continuous = true
              else if (notification.alarmType == 'single notice') notice = true
              if (notification.noPlay == true) noPlay = true
              if (notification.repeatGap) repeatGap = notification.repeatGap
              if (notification.msgServiceAlert) msgServiceAlert = true
              if (notification.playAfter) playAfter = now() + notification.playAfter * 1000
            } else {
              if (enableNotificationTypes[value.state] == 'continuous') continuous = true
              else if (enableNotificationTypes[value.state] == 'single notice') notice = true
            }

            if (update.timestamp) eventTimeStamp = new Date(update.timestamp).getTime()
            else eventTimeStamp = now()
            // Has notification type, otherwise delete from Q and only add if new path entry or if changing existing path's state (eg. alarm to alert)
            // and if messages changes && not bouncing/recent (except alarm & emergency)
            if (
              (alertQueue.get(nPath) || notice || continuous) &&
              (!alertQueue.get(nPath) ||
                !alertQueue.get(nPath).state ||
                alertQueue.get(nPath).state != value.state ||
                alertQueue.get(nPath).message != value.message) &&
              (!alertLog[nPath + '.' + value.state] ||
                alertLog[nPath + '.' + value.state].timestamp + repeatGap * 1000 < eventTimeStamp ||
                value.state == 'emergency' ||
                value.state == 'alarm')
            ) {
              let args = Object.create(soundEvent)
              args.audioFile = audioFile
              args.path = nPath
              args.state = value.state
              args.played = 0
              args.playAfter = playAfter
              args.disabled = notificationList[nPath].disabled

              args.numNotifications = 0
              if (audioFile && !noPlay) args.numNotifications++
              else args.audioFile = ''
              if (value.message) {
                args.numNotifications++
                args.message = value.message
              }
              if (notice) {
                args.mode = 'notice'
              } else if (continuous) {
                args.mode = 'continuous'
              }

              if (args.state != 'normal') {
                if (args.disabled != true) {
                  alertQueue.set(nPath, args) // active notification state, path not disabled, Q it!
                  lastAlert = args.path + '.' + args.state
                  alertLog[args.path + '.' + args.state] = { message: args.message, timestamp: eventTimeStamp }

                  app.debug(
                    'ADD2Q:' + args.path.substring(args.path.indexOf('.') + 1),
                    args.mode,
                    args.state,
                    'qSize:' + alertQueue.size
                  )

                  processQueue()
                }
              } else if (alertQueue.has(nPath)) {
                alertQueue.delete(nPath)
                app.debug('RMFQ:', args.path.substring(args.path.indexOf('.') + 1), 'qSize:', alertQueue.size)
              }

              logNotification({ path: args.path, state: args.state, mode: args.mode, disabled: args.disabled })

              if (msgServiceAlert && pluginProps.slackWebhookURL != null) {
                app.debug('Slack send:', args.path, args.message)
                SlackNotify(pluginProps.slackWebhookURL).send({
                  channel: pluginProps.slackChannel,
                  text: vesselName + ': ' + args.message,
                  fields: {
                    'SignalK Notification': args.path + ' / ' + args.state,
                    Message: args.message + ' @ ' + new Date(eventTimeStamp).toISOString(),
                    Value: app.getSelfPath(args.path.substring(args.path.indexOf('.') + 1) + '.value')
                  }
                })
              }
            }
            // resolved: state's notificationType has no continuous or single notice method, typical back to normal state
            else if (alertQueue.has(nPath) && !notice && !continuous) {
              app.debug('resolved: no method, removing')
              if (alertQueue.get(nPath).played != true && alertQueue.get(nPath).playAfter < now()) { // unless in playAfter state
                // try and play at least once but if cleared then only once
                alertQueue.get(nPath).mode = 'notice'
              } else alertQueue.delete(nPath) // no continuous or single notice method for this state so delete
            }
          } else if (alertQueue.has(nPath)) {
            // silenced: no method or sound method value
            app.debug('silenced: no method or sound method value, removing')
            if (alertQueue.get(nPath).played != true && alertQueue.get(nPath).playAfter < now()) {
              // try and play at least once but if cleared then only once, may change thinking on this
              alertQueue.get(nPath).mode = 'notice'
            } else alertQueue.delete(nPath)
          }
          if(value.state == 'normal') { // add normal states
            logNotification({ path: nPath, state: value.state })
          }
        }
      }) //  end loop for each notification update
    })
    if (alertQueue.size === 0 && queueActive) {
      stopProcessingQueue()
    }
  }

  function stopProcessingQueue() {
    //app.debug('stop playing')
    if (typeof playPID === 'number') process.kill(playPID)
    if (queueActive && pluginProps.postCommand && pluginProps.postCommand.length > 0) {
      queueActive = false
      const { exec } = require('node:child_process')
      app.debug('post-command: %s', pluginProps.postCommand)
      exec(pluginProps.postCommand)
    } else {
      queueActive = false
    }
  }

  function playEvent(soundEvent) {
    soundEvent.played++
    try {
      //app.debug('SOUND EVENT:',soundEvent)
      if (
        notificationPrePost[soundEvent.state] != false &&
        queueActive != true &&
        pluginProps.preCommand &&
        pluginProps.preCommand.length > 0
      ) {
        queueActive = true
        const { exec } = require('node:child_process')
        app.debug('pre-command: %s', pluginProps.preCommand)
        try {
          exec(pluginProps.preCommand)
        } catch (error) {
          app.error('ERROR:' + error)
          playBackActive = false
          processQueue()
        }
      } else queueActive = true

      if ((soundEvent.message && soundEvent.played == 2) || (!soundEvent.audioFile && soundEvent.played == 1)) {
        if (process.platform === 'linux' && !hasFestival) {
          app.debug('skipping saying:' + soundEvent.message, 'mode:' + soundEvent.mode, 'played:' + soundEvent.played)
          playBackActive = false
          processQueue()
        } else {
          app.debug('saying:' + soundEvent.message, 'mode:' + soundEvent.mode, 'played:' + soundEvent.played)
          try {
            say.speak(soundEvent.message, null, null, (err) => {
              playBackActive = false
              processQueue()
            })
          } catch (error) {
            app.error('ERROR:' + error)
            playBackActive = false
            processQueue()
          }
        }
      } else if (soundEvent.audioFile) {
        let command = pluginProps.alarmAudioPlayer
        soundFile = soundEvent.audioFile
        if (soundFile && soundFile.charAt(0) != '/') {
          soundFile = fspath.join(__dirname, 'sounds', soundFile)
        }

        if (fs.existsSync(soundFile)) {
          let args = [soundFile]
          if (pluginProps.alarmAudioPlayerArguments && pluginProps.alarmAudioPlayerArguments.length > 0) {
            args = [...pluginProps.alarmAudioPlayerArguments.split(' '), ...args]
          }
          app.debug('playing:' + soundEvent.audioFile, 'mode:' + soundEvent.mode, 'played:' + soundEvent.played)

          let play = child_process.spawn(command, args)
          playPID = play.pid

          play.on('error', (err) => {
            playPID = undefined
            app.error('Failed to play sound ' + err)
            playBackActive = false
            processQueue()
          })

          play.on('close', (code) => {
            playBackActive = false
            processQueue()
          })
        } else {
          app.debug('not playing, sound file missing:' + soundFile)
          playBackActive = false
          processQueue()
        }
      }
    } catch (error) {
      // catch all to make sure processing continue, no lockout
      app.error('PLAYBACK ERROR:' + error)
      playBackActive = false
      processQueue()
    }
  }

  function processQueue() {
    if (!playBackActive || playBackActive + playBackTimeOut < now()) {
      playPID = undefined
      if (muteUntil) {
        app.debug('Muted in processQueue to', muteUntil) // should we ever be here?
      } else if (alertQueue.size > 0) {
        if (queueIndex >= alertQueue.size) {
          queueIndex = 0
        }
        audioEvent = Array.from(alertQueue)[queueIndex][1]
        //app.debug('AE', audioEvent)

          // Q item not playable yet, move to next Q item, if no playable sleep
        if ((audioEvent.playAfter != 0 && audioEvent.playAfter > now()) || audioEvent.disabled) {
          queueIndex++
          let playableInQ = 0
          alertQueue.forEach((value, key) => {
            if (!value.playAfter && !value.disabled) playableInQ++
          })
          if (playableInQ) {
            delay(100).then(() => {
              processQueue()
            })
          } else {
            if (queueActive) stopProcessingQueue() // rare case when Q was active but now only waiting items
            //app.debug('Sleeping', (audioEvent.playAfter - now()) / 1000)
            delay(5000).then(() => {  // Q only contains non-playable items
              processQueue()
            })
          }

          //  Q item playable - play!
        } else if (audioEvent.played < audioEvent.numNotifications) {
          playBackActive = now() // timer / semaphore to prevent overlap of playback
          playEvent(audioEvent)

          //  Process Q item(s)
        } else {
          if (audioEvent.mode != 'continuous') {
            // single play so delete
            alertQueue.delete(audioEvent.path)
          } else {
            // continuous type, so reset counter
            audioEvent.played = 0
          }
          if (alertQueue.size > 0) {
            // increment to next in queue
            if (++queueIndex >= alertQueue.size) queueIndex = 0
            delay(250).then(() => {
              processQueue()
            })
          } else {
            if (queueActive) stopProcessingQueue()
            app.debug('Queue Empty, waiting...')
          }
        }
      } else {
        if (queueActive) stopProcessingQueue()
        app.debug('Queue Empty, waiting ...')
      }
    }
  }
  function logNotification(args) {
    arg2Log = { path: args.path, state: args.state }
    const lastEvent = notificationLog.findLast((item) => item.path === args.path)
    if (!lastEvent || lastEvent.state != args.state) {
      try {
        //process.nextTick(() => {  // weird hack to get updated value, w/o async call gets prev value
        if (typeof app.getSelfPath(args.path.substring(args.path.indexOf('.') + 1)) != 'undefined') {
          if( 'navigation.anchor' == args.path.substring(args.path.indexOf('.') + 1) )  // handle anchor watch API
            arg2Log.value = app.getSelfPath(args.path.substring(args.path.indexOf('.') + 1)).distanceFromBow.value
          else arg2Log.value = app.getSelfPath(args.path.substring(args.path.indexOf('.') + 1)).value
        } else arg2Log.value = null
        arg2Log.datetime = now()
        if(args.mode !== undefined) arg2Log.mode = args.mode
        if(args.disabled !== undefined) arg2Log.disabled = args.disabled

        if (!fs.existsSync(logFile)) {
          fs.writeFileSync(logFile, JSON.stringify(arg2Log))
        } else {
          fs.appendFileSync(logFile, ',\n' + JSON.stringify(arg2Log))
        }
        //})
      } catch (e) {
        app.error('Could not write:', logFile, '-', e)
      }
      notificationLog.push(arg2Log)
    }
    maintainLog(false)
  }

  function maintainLog(forceCheck) {   // Manage growing notificationLog and logFile size / always trouble
    if( notificationLog.length > 25000 || forceCheck ) {  //  check array size - edge case, or force check logFile at startup
      notificationLog = notificationLog.slice(-20000) 
      if( fs.statSync(logFile).size > 5242880) {   // chop down log file to something reasonable @ max 5 megs?
      //if( fs.statSync(logFile).size > 10000) {   // TESTING 

        const maxEntries = 150 // truncate to max entries per path (approx 1M w/ 50 paths)

        try {
          jsonArray = JSON.parse('[' + fs.readFileSync(logFile, 'utf-8') + ']') // wrap in []

          const lastEntries = jsonArray.filter((item, index, arr) => {
            const indices = arr.map((el, i) => (el.path === item.path ? i : -1)).filter((i) => i !== -1)
            return indices.slice(-maxEntries).includes(index)
          })

          const newJsonString = lastEntries.map((obj) => JSON.stringify(obj)).join(',\n')
          fs.writeFileSync(logFile, newJsonString, 'utf-8') // Overwrite the file with the truncated content
          app.debug(`Log file truncated to the last ${maxEntries} objects.`)
        } catch (error) {
          app.error('Error:', error)
        }
      }
    }
  }

  function now() {
    return Math.floor(Date.now())
  }

  function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time))
  }

  function readListFile(listFile) {
    if (fs.existsSync(listFile)) {
      let listString
      let list
      try {
        listString = fs.readFileSync(listFile, 'utf8')
      } catch (e) {
        app.error('Could not read ' + listFile + ' - ' + e)
        return
      }
      try {
        list = JSON.parse(listString)
      } catch (e) {
        app.error('Could not parse ' + e)
        return
      }
      for (const [path, val] of Object.entries(list)) {
        //if(val.disabled && typeof notificationList[path] != 'undefined') {
        if (val.disabled) {
          if (val.disabled) {
            alertQueue.delete(path) // remove event from Q / silence at startup
            if (typeof notificationList[path] != 'undefined') notificationList[path].disabled = true
            else notificationList[path] = { state: '', disabled: true }
          }
        }
      }
    }
  }

  function readLogFile(logFile) {
    if (fs.existsSync(logFile)) {
      let logString
      let logArray
      try {
        maintainLog(true) // trim log file if needed
        logString = fs.readFileSync(logFile, 'utf8')
      } catch (e) {
        app.error('Could not read ' + logFile + ' - ' + e)
        return
      }

      try {
        logArray = JSON.parse('[' + logString + ']') // wrap with []
      } catch (e) {
        app.error('Could not parse logfile ' + logFile + e)
        return
      }
      for (const logEntry of Object.values(logArray)) {
        notificationLog.push(logEntry)
      }
      maxEntries = 50 // Trim notificationLog array down to last 50 entries for each path
      const lastEntries = notificationLog.filter((item, index, arr) => {
        const indices = arr.map((el, i) => (el.path === item.path ? i : -1)).filter((i) => i !== -1)
        return indices.slice(-maxEntries).includes(index)
      })
      notificationLog = lastEntries
    }
  }

  function findObjectsEndingWith(obj, ending) {
    const results = []
    function traverse(current, path = '') {
      for (const key in current) {
        if (current.hasOwnProperty(key)) {
          let newPath = path ? `${path}.${key}` : key
          if (key.endsWith(ending)) {
            newPath = newPath.substring(0, newPath.lastIndexOf('.')) // strip final ending
            results.push({ path: newPath, value: current[key] })
          }
          if (typeof current[key] === 'object' && current[key] !== null) traverse(current[key], newPath)
        }
      }
    }
    traverse(obj)
    return results
  }

  plugin.schema = function () {
    let defaultAudioPlayer = 'mpg321'
    if (process.platform === 'darwin') defaultAudioPlayer = 'afplay'
    let notificationTypes = ['continuous', 'single notice', '-PLAYBACK DISABLED-']

    let schema = {
      type: 'object',
      description: 'Default Playback Method for Each (Emergency/Alarm/Warn/Alert) Notification Type:',
      required: ['enableEmergencies', 'enableAlarms', 'enableWarnings', 'enableAlerts'],
      properties: {
        t1: {
          type: 'object',
          title: 'Emergencies Notification Settings'
        },
        enableEmergencies: {
          type: 'string',
          enum: notificationTypes,
          title: 'Emergency - Playback Method',
          default: 'continuous'
        },
        emergencyAudioFile: {
          type: 'string',
          enum: notificationFiles,
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
          type: 'object',
          title: 'Alarm Notification Settings'
        },
        enableAlarms: {
          type: 'string',
          enum: notificationTypes,
          title: 'Alarm - Playback Method',
          default: 'continuous'
        },
        alarmAudioFile: {
          type: 'string',
          enum: notificationFiles,
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
          type: 'object',
          title: 'Warning Notification Settings'
        },
        enableWarnings: {
          type: 'string',
          enum: notificationTypes,
          title: 'Warning - Playback Method',
          default: 'single notice'
        },
        warnAudioFile: {
          type: 'string',
          enum: notificationFiles,
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
          type: 'object',
          title: 'Alert Notification Settings'
        },
        enableAlerts: {
          type: 'string',
          enum: notificationTypes,
          title: 'Alert - Playback Method',
          default: 'single notice'
        },
        alertAudioFile: {
          type: 'string',
          enum: notificationFiles,
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
          type: 'object',
          title: 'General Settings'
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
          enum: ['afplay', 'omxplayer', 'mpg321', 'mpg123']
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
          default: 0
        },
        playbackControlPrefix: {
          type: 'string',
          title: 'Signal K path prefix for playback control',
          default: 'digital.notificationPlayer',
          description:
            'Silence and resolve notification via SK paths (eg. digital.notificationPlayer + .silence .resolve .disable)'
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
                enum: ['emergency', 'alarm', 'warn', 'alert', 'normal', 'nominal'],
                title: 'Notification State',
                description: '(Notification Path can be assigned a custom action for each Notification State)',
                default: 'emergency'
              },
              alarmType: {
                type: 'string',
                enum: notificationTypes,
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
                enum: notificationFiles,
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
                description:
                  'Limit rate of notifications when bouncing in/out of this zone (seconds), ignored for emergency & alarm',
                type: 'number'
              },
              playAfter: {
                title: 'Minimum Time Notification Must Remain in Zone Before Notification is Played',
                description:
                  'Limit Transient Notifications: Seconds notification/value must remain in this zone state before notifcation is played',
                type: 'number',
                default: 0
              },
              msgServiceAlert: {
                type: 'boolean',
                title: 'Send Notification via Slack',
                description: 'Send notifcation to Slack channel (if Webhook URL configured above)',
                default: false
              }
            }
          }
        }
      }
    }

    if (typeof pluginProps !== 'undefined') {
      enableNotificationTypes.emergency = pluginProps.enableEmergencies
      enableNotificationTypes.alarm = pluginProps.enableAlarms
      enableNotificationTypes.warn = pluginProps.enableWarnings
      enableNotificationTypes.alert = pluginProps.enableAlerts

      notificationPrePost.emergency = pluginProps.prePostEmergency
      notificationPrePost.alarm = pluginProps.prePostAlarm
      notificationPrePost.warn = pluginProps.prePostWarn
      notificationPrePost.alert = pluginProps.prePostAlert

      if (pluginProps.emergencyAudioFileCustom) notificationSounds.emergency = pluginProps.emergencyAudioFileCustom
      else if (pluginProps.emergencyAudioFile) notificationSounds.emergency = pluginProps.emergencyAudioFile
      if (pluginProps.alarmAudioFileCustom) notificationSounds.alarm = pluginProps.alarmAudioFileCustom
      else if (pluginProps.alarmAudioFile) notificationSounds.alarm = pluginProps.alarmAudioFile
      if (pluginProps.warnAudioFileCustom) notificationSounds.warn = pluginProps.warnAudioFileCustom
      else if (pluginProps.warnAudioFile) notificationSounds.warn = pluginProps.warnAudioFile
      if (pluginProps.alertAudioFileCustom) notificationSounds.alert = pluginProps.alertAudioFileCustom
      else if (pluginProps.alertAudioFile) notificationSounds.alert = pluginProps.alertAudioFile
    }
    return schema
  }

  function subscribeToHandlers() {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: pluginProps.playbackControlPrefix + '.disable', value: false }] }]
    })
    app.registerPutHandler('vessels.self', pluginProps.playbackControlPrefix + '.disable', handleDisable)
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: pluginProps.playbackControlPrefix + '.silence', value: false }] }]
    })
    app.registerPutHandler('vessels.self', pluginProps.playbackControlPrefix + '.silence', handleSilence)
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: pluginProps.playbackControlPrefix + '.resolve', value: false }] }]
    })
    app.registerPutHandler('vessels.self', pluginProps.playbackControlPrefix + '.resolve', handleResolve)
    //app.handleMessage(plugin.id, { updates: [ { values: [ { path: 'digital.notificationPlayer.ignoreLast', value: false } ] } ] })
    //app.registerPutHandler('vessels.self', 'digital.notificationPlayer.ignoreLast', handleIgnoreLast)
  }

  function subscribeToNotifications() {
    const command = {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'notifications.*',
          policy: 'instant'
        }
      ]
    }
    app.subscriptionmanager.subscribe(command, unsubscribes, subscriptionError, processNotifications)
  }

  ////

  function silenceNotifications(path) {
    if (path) {
      app.debug('Silencing PATH:', path)
      const nvalue = app.getSelfPath(path)
      const nmethod = nvalue.value.method.filter((item) => item !== 'sound')
      const delta = {
        updates: [
          {
            values: [
              {
                path: path,
                value: {
                  state: nvalue.value.state,
                  method: nmethod,
                  message: nvalue.value.message
                }
              }
            ],
            $source: nvalue.$source
          }
        ]
      }
      app.handleMessage(plugin.id, delta)
    } else {
      //  Perhaps traverse all "notifications" instead of alertQueue????
      findObjectsEndingWith(app.getSelfPath('notifications'), 'value').forEach(function (update) {
        // load notificationList
        path = 'notifications.' + update.path
        const nvalue = app.getSelfPath(path)
        if (nvalue?.value?.state !== undefined && nvalue.value.state != 'normal') {
          app.debug('Silencing PATH:', path)
          const nmethod = nvalue.value.method.filter((item) => item !== 'sound')
          const delta = {
            updates: [
              {
                values: [
                  {
                    path: path,
                    value: {
                      state: nvalue.value.state,
                      method: nmethod,
                      message: nvalue.value.message
                    }
                  }
                ],
                $source: nvalue.$source
              }
            ]
          }
          app.handleMessage(plugin.id, delta)
        }
      })
    }
  }

  function resolveNotifications(path) {
    app.debug('Resolve Notifcations', path)
    Object.entries(alertLog).forEach(([key, value]) => {
      // check log for any alert played including ones silenced (currently not in alertQueue)
      key = key.substring(0, key.lastIndexOf('.'))
      if (!path || key == path) {
        const nvalue = app.getSelfPath(key)
        if (nvalue.value.state != 'normal' && nvalue.value.state != 'nominal') {
          // only clear -> set-to-normal elevated notification states
          //app.debug('Resolve Clearing:', key)
          const delta = {
            updates: [
              {
                values: [
                  {
                    path: key,
                    value: {
                      state: 'normal',
                      method: nvalue.value.method,
                      message: nvalue.value.message
                    }
                  }
                ],
                $source: nvalue.$source
              }
            ]
          }
          app.handleMessage(plugin.id, delta)
        }
      }
    })
  }

  ////

  function handleDisable(context, path, value, callback) {
    //app.debug('handleDisable', context, path, value)
    if (value == true) {
      //if( muteUntil == 0 )
      if (muteUntil - maxDisable * 1000 < now() - 1000) {
        // bounce check, accept at max 1hz rate
        muteUntil = now() + maxDisable * 1000 // 1hr max
        app.debug('Disabling in handleDisable', value)
        app.handleMessage(plugin.id, {
          updates: [{ values: [{ path: 'digital.notificationPlayer.disable', value: value }] }]
        })
        //muteUntil = now() + (300 * 1000)   // 5 minutes

        delay(maxDisable * 1000).then(() => {
          if (muteUntil <= now() && muteUntil != 0) {
            // check if later timer set and if not already cleared
            app.debug('Enabling in handleDisable via timeout')
            muteUntil = 0
            app.handleMessage(plugin.id, {
              updates: [{ values: [{ path: 'digital.notificationPlayer.disable', value: false }] }]
            })
            processQueue()
          }
        })
      }
    } else {
      app.debug('Enabling in handleDisable', value)
      muteUntil = 0
      app.handleMessage(plugin.id, {
        updates: [{ values: [{ path: 'digital.notificationPlayer.disable', value: false }] }]
      })
      processQueue()
    }
    return { state: 'COMPLETED', statusCode: 200 }
  }
  function handleSilence(context, path, value, callback) {
    silenceNotifications()
    return { state: 'COMPLETED', statusCode: 200 }
  }
  function handleResolve(context, path, value, callback) {
    resolveNotifications()
    return { state: 'COMPLETED', statusCode: 200 }
  }
  /*
  function handleIgnoreLast(context, path, value, callback) {
      if(!lastAlert) { return { state: 'COMPLETED', statusCode: 200 } }
      if( laVal = alertLog[lastAlert] ) {
        laVal.timestamp = now() + ( 1200 * 1000 )   // 20 minutes
        alertLog[lastAlert] = laVal   // set lastAlert time in the future to silence it until then
        alertQueue.delete(lastAlert.substr(0, lastAlert.lastIndexOf('.')))   // clear active Q entry / any type
      }
      return { state: 'COMPLETED', statusCode: 200 }
  }
*/

  function setZoneVal() {
    for (const path in notificationList) {
      pathTrimmed = path.substring(path.indexOf('.') + 1)
      z = pathTrimmed + '.meta.zones'
      app.debug('Zone Path:', z)
      app.getSelfPath(z).forEach(function (zone) {
        console.log('zone values', zone)
      })

      /*
        const nvalue = app.getSelfPath(qPath)
        const delta = {
          updates: [{
            values: [{
              path: qPath,
                value: {
                  state: nvalue.value.state
               }
            }],
            $source: nvalue.$source,
          }]
        }
        app.handleMessage(plugin.id, delta)
      }
    }
   */
    }
  }
  //

  plugin.registerWithRouter = (router) => {
    router.get('/silence', (req, res) => {
      silenceNotifications(req._parsedUrl.query)
      res.send('Active Notifications Silenced')
    })

    router.get('/resolve', (req, res) => {
      resolveNotifications(req._parsedUrl.query)
      res.send('Active Notifications Resolved')
    })

    router.get('/disablePath', (req, res) => {
      // disable path specific playback
      res.send('Ok')
      const path = req._parsedUrl.query.split('?')[0]
      //app.debug('disablePath:', path+'='+req._parsedUrl.query.split('?')[1])
      if (typeof notificationList[path] == 'undefined') return

      if (req._parsedUrl.query.split('?')[1] == 'true') {
        notificationList[path].disabled = true
        silenceNotifications(path) // silence any active notifications
      } else {
        notificationList[path].disabled = false
        if (alertQueue.get(path) !== undefined) {
          if (alertQueue.get(path).disabled) alertQueue.get(path).disabled = false
        }
      }
      let notificationListTrimmed = {}
      for (const key in notificationList) {
        if (notificationList[key].disabled == true) {
          notificationListTrimmed[key] = { disabled: notificationList[key].disabled }
        }
      }
      try {
        fs.writeFileSync(listFile, JSON.stringify(notificationListTrimmed, null, 2))
      } catch (e) {
        app.error('Could not write ' + listFile + ' - ' + e)
      }
    })


    router.get('/log', (req, res) => {
      const path = req._parsedUrl.query.split('?')[0]
      const numEvents = req._parsedUrl.query.split('?')[1]
      if (numEvents && !(numEvents > 0)) numEvents = 10 // default to last 10 events
      const logSnip = JSON.stringify(
        notificationLog
          .filter((entry) => entry.path === path)
          .sort((a, b) => b.datetime - a.datetime)
          .slice(0, numEvents)
      )
      res.set({ 'Content-Type': 'application/json' })
      res.send(logSnip)
    })

    router.get('/disable', (req, res) => {
      // disable all playback
      var muteTime = parseInt(req._parsedUrl.query)
      if (isNaN(muteTime)) {
        muteTime = maxDisable
      } // default set @ top 3600 seconds
      if (muteTime > 28800) {
        muteTime = 18800 // max 8hr disable
        res.send('Disable playback for ' + muteTime + ' seconds, maxmium allowed.')
      } else if (muteTime < 0) {
        res.json(pluginProps.playbackControlPrefix)
        return // special case, just return path
      } else {
        res.send('Disable playback for ' + muteTime + ' seconds')
      }
      app.debug('Disable playback for next', muteTime, 'seconds')
      muteUntil = now() + muteTime * 1000
      app.handleMessage(plugin.id, {
        updates: [{ values: [{ path: 'digital.notificationPlayer.disable', value: true }] }]
      })
      delay(muteTime * 1000).then(() => {
        if (muteUntil <= now() && muteUntil != 0) {
          // check if later timer set and if not already cleared
          app.debug('Enable playback')
          app.handleMessage(plugin.id, {
            updates: [{ values: [{ path: 'digital.notificationPlayer.disable', value: false }] }]
          })
          muteUntil = 0
          processQueue()
        }
      })
    })

    router.get('/list', (req, res) => {
      const vlist = {}
      notificationList = Object.fromEntries(Object.entries(notificationList).sort((a, b) => a[0].localeCompare(b[0])))
      for (const path in notificationList) {
        if (path.startsWith('notifications.navigation.anchor')) {
          nvalue = app.getSelfPath(path.substring(path.indexOf('.') + 1) + '.distanceFromBow') // anchor watch api path
        } else {
          nvalue = app.getSelfPath(path.substring(path.indexOf('.') + 1)) // strip leading notifiction from typical path
        }
        const state = notificationList[path].state
        const disabled = notificationList[path].disabled
        if (nvalue) {
          const pathValues = {
            state: state,
            disabled: disabled,
            value: nvalue.value,
            units: nvalue.meta.units,
            timestamp: nvalue.timestamp
          }
          vlist[path] = pathValues
        }
      }
      res.send(vlist)
    })

    router.get('/szv', (req, res) => {
      //setZoneVal()
      findObjectsEndingWith(app.getSelfPath('notifications'), 'value').forEach(function (update) {
        app.debug('PV', 'notifications.' + update.path, update.value.state)
      })
      res.send('szv ok')
    })
    /*
    router.get('/ignoreLast', (req, res) => {
      if(!lastAlert) { res.send('No alerts to mute.') ; return }
      var muteTime = parseInt(req._parsedUrl.query)
      if ( isNaN(muteTime) ) { muteTime = 600 }   // default 600 seconds
      if (muteTime > maxDisable) {  // max 1hr
        muteTime = maxDisable
        res.send('Muting '+lastAlert+ ' playback for '+muteTime+' seconds, maxmium allowed.')
      } else {
        res.send('Muting '+lastAlert+ ' playback for '+muteTime+' seconds')
      }
      if( laVal = alertLog[lastAlert] ) {
        laVal.timestamp = now() + ( muteTime * 1000 )
        alertLog[lastAlert] = laVal   // set lastAlert time in the future to silence it until then
        alertQueue.delete(lastAlert.substr(0, lastAlert.lastIndexOf('.')))   // clear active Q entry / any type
      }
      app.debug('Muting PB for', lastAlert, 'next', muteTime, 'seconds')
      //for (type in enableNotificationTypes) { app.debug(type) }
      //app.debug('alertLog:', alertLog) ; //app.debug('alertQueue:', alertQueue)
    })
*/
  } // end registerWithRouter()

  return plugin
}
// END //
