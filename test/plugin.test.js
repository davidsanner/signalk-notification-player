const path = require('path');
const fs = require('fs');

// 1. Mock the Advanced Signal K v2 Server Environment
const mockApp = {
  id: 'signalk-server-mock',
  
  // Mocks core native server v2 notification control methods
  notifications: {
    silenceAll: () => {
      console.log('[MOCK-V2 CORE] app.notifications.silenceAll() successfully executed!');
      return { state: 'SUCCESS' };
    }
  },
  
  // Mocks local variable tree storage
  getSelfPath: (key) => {
    if (key === 'name') return 'V2 Test Vessel';
    
    // Simulates the native structure of a Signal K v2 Notifications state tree
    if (key === 'notifications') {
      return {
        'navigation': {
          'anchor': {
            'value': {
              'state': 'alarm',
              'message': 'Anchor Drag Alarm (V2 Context)',
              'method': ['sound', 'visual'],
              'timestamp': new Date().toISOString()
            }
          }
        }
      };
    }
    return undefined;
  },

  // Environment data directories
  getDataDirPath: () => __dirname,

  // Server logger routing
  debug: (...args) => console.log('[V2-DEBUG]', ...args),
  error: (...args) => console.error('[V2-ERROR]', ...args),

  // Subscription Manager mock (captures the initialization binding)
  subscriptionmanager: {
    subscribe: (command, unsubscribes, errorCallback, processNotificationsCallback) => {
      console.log('[MOCK-V2] Bound to delta stream:', JSON.stringify(command.subscribe));
      global.v2StreamTrigger = processNotificationsCallback;
      unsubscribes.push(() => console.log('[MOCK-V2] Stream detached'));
    }
  },

  // v2 API Action Handlers for Put Operations (e.g. Muting / Silencing endpoints)
  handleMessage: (pluginId, delta) => {
    console.log(`\n[V2-API EVENT] Outbound Delta Hook from ${pluginId}:`);
    console.log(JSON.stringify(delta, null, 2));
  },

  registerPutHandler: (context, apiPath, callback) => {
    console.log(`[V2-ENDPOINT] Registered PUT endpoint: /signalk/v2/api/resources/${apiPath}`);
    // Expose muting/silencing handles directly to our manual test execution loop
    if (!global.v2PutEndpoints) global.v2PutEndpoints = {};
    global.v2PutEndpoints[apiPath] = callback;
  }
};

// 2. Load the target plugin using parent directory relative resolution
const pluginFactory = require('../index.js');
const plugin = pluginFactory(mockApp);

// 3. Setup configuration matching the plugin schema structure
const testConfig = {
  repeatGap: 2, 
  playbackControlPrefix: 'notifications.control', // Setting path prefix matching v2 patterns
  alarmAudioPlayer: 'afplay', // Mac default (changes to mpg321 for Linux/Raspberry Pi)
  enableEmergencies: 'continuous',
  enableAlarms: 'continuous',
  enableWarnings: 'single notice',
  enableAlerts: 'single notice',
  mappings: [
    {
      path: 'notifications.navigation.anchor',
      state: 'alarm',
      alarmType: 'continuous',
      noPlay: false,
      msgServiceAlert: false
    }
  ]
};

// 4. Test Execution Control Flow
console.log('=== LOGGING ON: SIGNAL K V2 MOCK SERVER ===');
plugin.start(testConfig);

// SCENARIO 1: Simulate raising an active alert through the stream pipeline
setTimeout(() => {
  console.log('\n=========================================');
  console.log('SCENARIO 1: Injecting v2 Anchor Alarm State');
  console.log('=========================================');
  
  const v2AlarmDelta = {
    updates: [{
      timestamp: new Date().toISOString(),
      values: [{
        path: 'notifications.navigation.anchor',
        value: {
          state: 'alarm',
          message: 'Depth critical! Dragging anchor!',
          method: ['sound', 'visual']
        }
      }]
    }]
  };

  if (global.v2StreamTrigger) {
    global.v2StreamTrigger(v2AlarmDelta);
  }
}, 1000);

// SCENARIO 2: Simulate a user clicking "Mute/Silence" in a modern v2 Web App UI Interface
setTimeout(() => {
  console.log('\n=========================================');
  console.log('SCENARIO 2: Simulating User Mute API PUT');
  console.log('=========================================');

  const silenceControlPath = 'notifications.control.silence';
  
  if (global.v2PutEndpoints && global.v2PutEndpoints[silenceControlPath]) {
    console.log(`[UI] Sending PUT request to /signalk/v2/api/${silenceControlPath}`);
    
    // Invoke the plugin's native handler bound during setup
    const response = global.v2PutEndpoints[silenceControlPath](
      'vessels.self', 
      silenceControlPath, 
      true, 
      () => {}
    );
    
    console.log('[API RESPONSE STATUS]:', JSON.stringify(response));
  } else {
    console.error('Mute PUT handler endpoints are missing or misconfigured!');
  }
}, 3000);

// SCENARIO 3: Cleanup and Shutdown Lifecycle
setTimeout(() => {
  console.log('\n=========================================');
  console.log('SCENARIO 3: Shutting Down Mock Environment');
  console.log('=========================================');
  
  plugin.stop();
  
  // Delete dynamic persistent files left behind by the plugin run tracking
  try {
    fs.unlinkSync(path.join(__dirname, 'notificationList.json'));
    fs.unlinkSync(path.join(__dirname, 'notificationLog.json'));
    console.log('[CLEANUP] Deleted mock state files cleanly.');
  } catch(e) {}
  
  console.log('=== TEST CYCLE RUN COMPLETED ===');
  process.exit(0);
}, 5000);

