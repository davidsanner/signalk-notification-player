//
//  signalk-notifcation-player webapp
//
const BASE_URL = '/plugins/signalk-notification-player'
const SELF_URL = '/signalk/v1/api/vessels/self'
let popupActive = false // keep popup data from reloading when main table reloads
let popupActiveState = false // keep popup data from reloading when main table reloads
let vesselName = ''
let redrawTimer
let updateDisable = false
let playbackControlPrefix = ''
let persistedPathDisabled = new Map()
let serverStartedAt = null
const STARTUP_TIMESTAMP_TOLERANCE_MS = 15000
const CLEAR_HISTORY_MAX_MS = 12 * 60 * 60 * 1000
const CLEAR_HISTORY_STORAGE_KEY = 'signalk-notification-player.clearHistory'
function loadClearHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(CLEAR_HISTORY_STORAGE_KEY) || '{}')
    const now = Date.now()
    Object.entries(saved).forEach(([path, ts]) => {
      if (!Number.isFinite(ts) || now - ts < 0 || now - ts >= CLEAR_HISTORY_MAX_MS) {
        delete saved[path]
      }
    })
    localStorage.setItem(CLEAR_HISTORY_STORAGE_KEY, JSON.stringify(saved))
  } catch (_) {}
}
function saveClearHistory(path, ts) {
  try {
    const now = Date.now()
    const saved = JSON.parse(localStorage.getItem(CLEAR_HISTORY_STORAGE_KEY) || '{}')
    Object.keys(saved).forEach((p) => {
      if (!Number.isFinite(saved[p]) || now - saved[p] >= CLEAR_HISTORY_MAX_MS) delete saved[p]
    })
    if (Number.isFinite(ts)) saved[path] = ts
    else delete saved[path]
    localStorage.setItem(CLEAR_HISTORY_STORAGE_KEY, JSON.stringify(saved))
  } catch (_) {}
}

const table = document.createElement('table')
const headerRow = document.createElement('tr')
const SPINNER_FRAMES = ['/', '-', '\\', '-']
const bgColorList = {
  emergency: '#ff0000',
  alarm: '#ff5555',
  warn: 'yellow',
  alert: 'olive',
  normal: '#768670',
  nominal: '#9bb194'
}
const ackHighlightStyle = document.createElement('style')
ackHighlightStyle.textContent = `
.resolve-button {
  background-color: #aaa;
  color: #555;
  border-color: #888;
  box-shadow: 2px 2px 3px black;
}
.resolve-button.needs-acknowledge {
  background-color: buttonface;
  color: buttontext;
  font-weight: 700;
  outline: 1px solid #000;
  outline-offset: 1px;
  box-shadow: 2px 2px 3px black;
}
.silence-button {
  background-color: #aaa;
  color: #555;
  border-color: #888;
  box-shadow: 2px 2px 3px black;
}
.silence-button.active-sound {
  background-color: buttonface;
  color: buttontext;
  font-weight: 700;
  outline: 1px solid #000;
  outline-offset: 1px;
  box-shadow: 2px 2px 3px black;
}
`
document.head.appendChild(ackHighlightStyle)

const listContent = document.getElementById('list-div')

function buildTableHeader() {
listContent.innerHTML = ''

headerRow.innerHTML =
  '<th style="font-size: large">' +
  vesselName +
  ' Zone Path</th><th>Value</th><th>Age<br></th><th id="showAllNotifications-state">State</th><th>Disable</th><th span=2><button id=silenceAll>Silence All</button></th>'
table.appendChild(headerRow)
listContent.appendChild(table)
document.getElementById(`silenceAll`).addEventListener('click', processSilence)
document.getElementById('playbackDisabled').addEventListener('click', processDisable)
document.getElementById('playbackDisabled').checked = updateDisable
}

async function fetchServerStartedAt() {
  try {
    const response = await fetch(BASE_URL + '/server-start', { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    const parsed = new Date(data.startedAt).getTime()
    if (Number.isFinite(parsed)) serverStartedAt = parsed
  } catch (error) {
    console.error('Fetching server start time:', error)
  }
}

function isNormalState(state) {
  return state === 'normal' || state === 'nominal'
}

function isElevatedState(state) {
  return !!state && !isNormalState(state)
}

function startupTimestamp(timestamp) {
  if (!serverStartedAt || !timestamp) return false
  const ts = new Date(timestamp).getTime()
  return Number.isFinite(ts) && Math.abs(ts - serverStartedAt) <= STARTUP_TIMESTAMP_TOLERANCE_MS
}

async function getJSON(endpoint) {
  try {
    const response = await fetch(`${endpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error(`Error fetching data: ${response.statusText}`)
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error('Error:', error)
    return null
  }
}
async function fetchPersistedPathDisabled() {
  try {
    const listData = await getJSON(BASE_URL + '/list')
    if (!listData || typeof listData !== 'object') return
    persistedPathDisabled = new Map()
    Object.entries(listData).forEach(([path, item]) => {
      if (item && item.disabled === true) persistedPathDisabled.set(path, true)
    })
  } catch (_) {
    // Optional startup state; normal table discovery must continue.
  }
}

async function processNotification(endpoint) {
  try {
    const response = await fetch(`${endpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'text/html'
      }
    })

    if (!response.ok) {
      throw new Error(`Error fetching data: ${response.statusText}`)
    }

    const data = await response.text()
    return data
  } catch (error) {
    console.error('Error:', error)
    return null
  }
}

function updateTimeStamp(status) {
  const now = new Date()
  if (status) document.getElementById('timestamp').textContent = now.toLocaleTimeString()
  else {
    const errMsg = document.getElementById('timestamp')
    errMsg.innerHTML = '<div style="font-size: x-large; color:#F00;">COMMUNICATION ERROR</div>'
  }
}

function applyPlaybackDisabledUI() {
  const statusElement = document.getElementById('overlay')
  const checkbox = document.getElementById('playbackDisabled')
  if (updateDisable === true) {
    listContent.style.opacity = '.5'
    statusElement.style.display = 'flex'
    statusElement.textContent = 'Notification Playback Disabled'
    checkbox.checked = true
  } else {
    listContent.style.opacity = '1'
    statusElement.style.display = 'none'
    checkbox.checked = false
  }
}

function createTableRow(path) {
  const row = document.createElement('tr')
  row.id = 'row-' + path
  row.innerHTML = `<td class="path-cell"></td><td class="value-cell"></td><td class="age-cell"></td><td class="state-cell"></td><td class="disable-cell"><input type="checkbox"></td><td class="action-cell"><button class="silence-button">Silence</button>&nbsp;&nbsp;<button class="resolve-button">Acknowledge</button></td>`

  row.querySelector('.resolve-button').id = path + '-resolve'
  row.querySelector('.silence-button').id = path + '-silence'
  row.querySelector('.resolve-button').addEventListener('click', processResolve)
  row.querySelector('.silence-button').addEventListener('click', processSilence)
  row.querySelector('.disable-cell input').id = path + '-disabled'
  row.querySelector('.disable-cell input').addEventListener('click', processPathDisable)

  const pathCell = row.querySelector('.path-cell')
  const stateCell = row.querySelector('.state-cell')
  pathCell.id = path.substring(path.indexOf('.') + 1)
  stateCell.id = pathCell.id + '-state'

  pathCell.addEventListener('mouseout', () => {
    document.getElementById('popupContent').style.display = 'none'
    popupActive = false
  })
  stateCell.addEventListener('mouseout', () => {
    document.getElementById('popupContentState').style.display = 'none'
    popupActiveState = false
  })
  pathCell.addEventListener('mouseover', processMouseOver)
  stateCell.addEventListener('mouseover', processMouseOverState)

  table.appendChild(row)
  return row
}

function decimalPlacesFromDisplayFormat(displayFormat) {
  if (typeof displayFormat !== 'string') return null
  const match = displayFormat.match(/\.([0#]+)/)
  return match ? match[1].length : 0
}

function abbreviateDisplayUnit(unit) {
  if (!unit) return ''
  const normalized = String(unit).trim().toLowerCase()
  const abbreviations = {
    foot: 'ft', feet: 'ft',
    gallon: 'gal', gallons: 'gal',
    liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    'liter/hour': 'l/hr', 'liters/hour': 'l/hr',
    'litre/hour': 'l/hr', 'litres/hour': 'l/hr',
    hour: 'hr', hours: 'hr'
  }
  return abbreviations[normalized] || unit
}

function convertDisplayValue(rawValue, displayUnits) {
  if (typeof rawValue !== 'number' || !displayUnits || !displayUnits.formula) return null

  // Signal K unit-preference formulas are Math.js expressions. The standard
  // definitions are simple arithmetic expressions involving `value`. Limit
  // evaluation to that subset so arbitrary JavaScript cannot be executed.
  const formula = String(displayUnits.formula)
  const stripped = formula.replace(/\bvalue\b/g, '').replace(/[0-9eE+\-*/().\s]/g, '')
  if (stripped.length !== 0) {
    console.warn('[units] unsupported display formula:', formula)
    return null
  }

  try {
    const converted = Function('value', `'use strict'; return (${formula})`)(rawValue)
    if (typeof converted !== 'number' || !Number.isFinite(converted)) return null
    return converted
  } catch (error) {
    console.warn('[units] failed display conversion:', formula, error)
    return null
  }
}

function formatNumericValue(value, displayFormat) {
  // Zoned paths are not necessarily numeric (for example trend/severity or
  // other enumerated/string values). Only apply numeric formatting to actual
  // finite numbers; preserve other values for display.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (value == null) return 'n/a'
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value)
      } catch (_) {
        return String(value)
      }
    }
    return String(value)
  }

  const places = decimalPlacesFromDisplayFormat(displayFormat)
  if (places !== null) return value.toFixed(places)
  if (Math.abs(value) >= 1000) return String(Math.round(value))
  let text = value.toPrecision(3)
  if (text == 0.0) text = '0'
  else if (text == 1.0) text = '1'
  return text
}

function renderRow(path, value) {
  let age
  const row = document.getElementById('row-' + path) || createTableRow(path)
  const bgc = bgColorList[value.state] || '#BBB'
  const state = value.state
  const pathTrimmed = path.substring(path.indexOf('.') + 1)
  const pathCell = row.querySelector('.path-cell')
  const valueCell = row.querySelector('.value-cell')
  const ageCell = row.querySelector('.age-cell')
  const stateCell = row.querySelector('.state-cell')
  const disabledInput = row.querySelector('.disable-cell input')
  const resolveButton = row.querySelector('.resolve-button')
  const silenceButton = row.querySelector('.silence-button')

  let pathVal
  let pathUnits
  let bgAge = 'color:#DDD'

  if (typeof value.value !== 'undefined') {
    pathVal = value.value
    pathUnits = value.units
    if (pathVal == null) {
      pathVal = 'n/a'
      pathUnits = ''
    } else if (pathVal === true || pathVal === false) {
      pathUnits = ''
    } else {
      const converted = convertDisplayValue(pathVal, value.displayUnits)
      if (converted !== null) {
        pathVal = formatNumericValue(converted, value.displayUnits.displayFormat)
        pathUnits = value.displayUnits.symbol || value.displayUnits.targetUnit || pathUnits || ''
      } else {
        // Compatibility fallback for servers/paths without displayUnits metadata.
        // These conversions only make sense for numeric values. String/enumerated
        // paths (for example trend/severity) should be displayed unchanged.
        if (typeof pathVal === 'number' && Number.isFinite(pathVal)) {
          if (!pathUnits) pathUnits = ''
          else if (pathUnits === 'K') {
            pathUnits = 'C'
            pathVal = pathVal - 273.15
          } else if (pathUnits === 'ratio') {
            pathUnits = '%'
            pathVal = pathVal * 100
          } else if (pathUnits === 'm3') {
            pathUnits = 'L'
            pathVal = pathVal * 1000
          } else if (pathUnits === 's') {
            if (pathVal >= 3600) {
              pathUnits = 'hr'
              pathVal = pathVal / 3600
            } else if (pathVal >= 60) {
              pathUnits = 'm'
              pathVal = pathVal / 60
            }
          }
        } else if (!pathUnits) {
          pathUnits = ''
        }
        pathVal = formatNumericValue(pathVal)
      }
    }

    pathUnits = abbreviateDisplayUnit(pathUnits)

    age = (Date.now() - new Date(value.timestamp).getTime()) / 1000
    if (value.fastUpdating && age < 15) {
      ageCell.textContent = ' ' + SPINNER_FRAMES[value.ageToggleIndex || 0] + ' '
      ageCell.style.cssText = bgAge
    } else {
      age = Math.trunc(age)
      if (age > 60) bgAge = 'color:#C04000;font-weight:bold'
      else if (age > 15) bgAge = 'color:#7E3817;font-weight:bold'
      ageCell.style.cssText = bgAge
      if (age >= 3600) age = Math.trunc(age / 3600) + 'h'
      else if (age >= 60) age = Math.trunc(age / 60) + 'm'
      else age = ' ' + age + 's'
      ageCell.textContent = age
    }
  } else {
    pathVal = 'error'
    pathUnits = ''
    ageCell.textContent = '-'
    ageCell.style.cssText = bgAge
  }

  pathCell.textContent = pathTrimmed
  pathCell.style.backgroundColor = value.disabled ? '#7E3817' : ''
  valueCell.textContent = pathVal === 'n/a' ? 'n/a' : `${pathVal} ${pathUnits}`.trim()
  stateCell.textContent = state
  stateCell.style.backgroundColor = bgc
  stateCell.style.color = ''
  stateCell.style.fontWeight = ''

  // A normal/nominal state can carry a short-lived visual history showing that
  // an elevated notification recently cleared by itself. No timer or network
  // traffic is needed; the existing redraw calculates the age from clearedAt.
  if (isNormalState(state) && value.clearedAt) {
    const clearedAge = Date.now() - value.clearedAt
    if (clearedAge >= 0 && clearedAge < 60 * 60 * 1000) {
      stateCell.style.color = '#000'
      stateCell.style.fontWeight = '700'
    } else if (clearedAge < 6 * 60 * 60 * 1000) {
      stateCell.style.color = '#444'
      stateCell.style.fontWeight = '700'
    } else if (clearedAge < CLEAR_HISTORY_MAX_MS) {
      stateCell.style.color = '#666'
      stateCell.style.fontWeight = '400'
    }
  }
  disabledInput.checked = !!value.disabled

  // Draw attention to active notifications that still need acknowledgement.
  // Do not tie this to sound playback: silenced/one-shot notifications can
  // remain active and still require acknowledgement.
  const acknowledged = !!(value.status && value.status.acknowledged)
  const needsAcknowledge = state && state !== 'nominal' && state !== 'normal' && !acknowledged
  if (resolveButton) {
    resolveButton.classList.toggle('needs-acknowledge', needsAcknowledge)
  }

  // Highlight Silence only for an active notification whose Signal K method
  // includes sound. All other Silence buttons stay visually de-emphasized.
  const hasSoundMethod = Array.isArray(value.method)
    ? value.method.includes('sound')
    : typeof value.method === 'string' && value.method.includes('sound')
  const activeSound = state && state !== 'nominal' && state !== 'normal' && hasSoundMethod
  if (silenceButton) {
    silenceButton.classList.toggle('active-sound', !!activeSound)
  }
}

function updateList(data) {
  applyPlaybackDisabledUI()
  Object.entries(data).forEach(([path, value]) => {
    renderRow(path, value)
    table.appendChild(document.getElementById('row-' + path))
  })

  const stateHeader = document.getElementById('showAllNotifications-state')
  if (stateHeader && !stateHeader.dataset.handlersAttached) {
    stateHeader.addEventListener('mouseover', processMouseOverState)
    stateHeader.addEventListener('mouseout', () => {
      document.getElementById('popupContentState').style.display = 'none'
      popupActiveState = false
    })
    stateHeader.dataset.handlersAttached = 'true'
  }
}

function processMouseOver(event) {
  popupActive = true
  let zonePath
  if (event.target.id.includes('navigation.anchor'))
    zonePath = SELF_URL + '/' + event.target.id.replaceAll('.', '/') + '/meta/value/zones'
  else zonePath = SELF_URL + '/' + event.target.id.replaceAll('.', '/') + '/meta/zones'
  fetch(zonePath)
    .then((response) => response.text())
    .then((text) => {
      text = text.replaceAll('},{', '}<hr>{')
      text = text.replace(/[\[\]]/g, '')
      if (text.includes('Cannot GET ')) document.getElementById('zones').innerHTML = '---'
      else document.getElementById('zones').innerHTML = text
    })
    .catch((error) => {
      //console.error('Error:', error);
    })

  document.getElementById('popupContent').innerHTML =
    'Zone MetaData for:&nbsp;<div style="display:inline; font-size: medium; color:#800;">' +
    event.target.id +
    '</div><hr><div id=zones>loading zones...</div>'
  document.getElementById('popupContent').style.display = 'block'
}

async function processMouseOverState(event) {
  let showAll = false
  let query
  const maxShown = 8
  const path = event.target.id.substring(0,event.target.id.indexOf('-'))
  popupActiveState = true
  document.getElementById('popupContentState').style.display = 'block'

  if( path == "showAllNotifications" ) {
    showAll = true
    query = BASE_URL + '/log?' + maxShown * 2
    document.getElementById('popupContentState').innerHTML =
      '<div style="display:inline; font-size: small; color:#800;">Most Recent Notifications<hr></div><div id=zonesState>loading...</div>'
  } else {
    query = BASE_URL + '/log?' + path + "?" + maxShown
    document.getElementById('popupContentState').innerHTML =
      'Last Notification:&nbsp;<div style="display:inline; font-size: small; color:#800;">' + path +
      '</div><hr><div id=zonesState>loading...</div>'
  }
  getJSON(query).then(data => {
      if (data.includes('Cannot GET ')) document.getElementById('zonesState').innerHTML = '---'
      let text = JSON.stringify(data)
      text = text.replaceAll('},{', '}<hr>{')
      text = text.replace(/[\[\]]/g, '')
      let html = "<table>"
      for (const item of data) {
        if(typeof item.value === 'number') item.value = item.value.toPrecision(5)
        if(showAll) html += "<tr><td>"+item.path+"</td><td>State: "+item.state+"</td><td>Value: "+item.value+"</td><td>Since: "+formattedDT(new Date(item.datetime))+"</td></tr>";
        else html += "<tr><td>State: "+item.state+"</td><td>Value: "+item.value+"</td><td>Since: "+formattedDT(new Date(item.datetime))+"</td></tr>";
      }
      html += "</table>"
      document.getElementById('zonesState').innerHTML = html
  });
}

function formattedDT( date ) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')
  return(`${year}/${month}/${day} ${hours}:${minutes}:${seconds}`)
}

async function fetchVesselName() {
  const data = await getJSON(SELF_URL + '/name')
  if (data) vesselName = data + ' :'
}

function processResolve(event) {
  processNotification(BASE_URL + '/resolve?' + event.target.id.slice(0, event.target.id.lastIndexOf('-')))
}

function processSilence(event) {
  if (event.target.id == 'silenceAll') {
    processNotification(BASE_URL + '/silence')
    handleSoundEvent({ kind: 'stop' })
  } else processNotification(BASE_URL + '/silence?' + event.target.id.slice(0, event.target.id.lastIndexOf('-')))
}

function processDisable(event) {
  if (event.target.checked) {
    updateDisable = true
    processNotification(BASE_URL + '/disable')
  } else {
    updateDisable = false
    processNotification(BASE_URL + '/disable?0')
  }
  redrawTable()
}

function processPathDisable(event) {
  const path = event.target.id.slice(0, -'-disabled'.length)
  const checked = event.target.checked
  processNotification(BASE_URL + '/disablePath?' + path + '?' + checked)
  if (checked) persistedPathDisabled.set(path, true)
  else persistedPathDisabled.delete(path)
  if (tableRows[path]) {
    tableRows[path].disabled = checked
    renderRow(path, tableRows[path])
  }
}

let lastAnchorNullCheck = 0
async function verifyAnchorCurrentRadiusNull() {
  const row = tableRows['notifications.navigation.anchor']
  if (!row || row.value == null || !row.timestamp) return
  const ageMs = Date.now() - new Date(row.timestamp).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 5000) return
  const now = Date.now()
  if (now - lastAnchorNullCheck < 10000) return
  lastAnchorNullCheck = now
  try {
    const response = await fetch('/signalk/v1/api/vessels/self/navigation/anchor/currentRadius', { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    const current = data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'value') ? data.value : data
    if (current === null) {
      row.value = null
      row.timestamp = new Date().toISOString()
      renderRow('notifications.navigation.anchor', row)
    }
  } catch (_) {}
}
function startRedrawTimer() {
  // fixed local clock, purely so the Age column keeps ticking up - no network call
  if (redrawTimer) clearInterval(redrawTimer)
  redrawTimer = setInterval(redrawTable, 1000)
}

function redrawTable() {
    verifyAnchorCurrentRadiusNull()
  const sorted = {}
  Object.keys(tableRows)
    .sort()
    .forEach((p) => (sorted[p] = tableRows[p]))
  updateList(sorted)
}

//
// Live, event-driven data model, scoped to only the paths that matter.
// Metadata changes are signalled by the plugin; there is no periodic /list or
// full-vessel polling after startup.
//
let zonedPaths = []
let tableRows = {}
let liveSocket = null
let reconnectTimer = null
let discoveryInProgress = false
let discoveryPending = false
let discoveryFallbackTimer = null
let subscribedPaths = new Set()
let hasConnectedOnce = false
let newPathAnnouncementsArmed = false
let startupDiscoveryComplete = false
let knownModelPaths = new Set()
let announcedMetaChecks = new Set()

function notifPathForZonedPath(zonedPath) {
  if (zonedPath === 'navigation.anchor.currentRadius') return 'notifications.navigation.anchor'
  return 'notifications.' + zonedPath
}

const ALWAYS_SUBSCRIBE_RAW_PATHS = ['navigation.anchor.currentRadius']
const ALWAYS_SUBSCRIBE_NOTIF_PATHS = ['notifications.navigation.anchor']

function walkForZones(obj, prefix, found) {
  if (!obj || typeof obj !== 'object') return
  if (obj.meta && obj.meta.zones && obj.meta.zones.length > 0) {
    const cleanPath = prefix.replace(/^\./, '')
    found.push({
      path: cleanPath,
      value: obj.value,
      timestamp: obj.timestamp,
      units: obj.meta.units,
      displayUnits: obj.meta.displayUnits
    })
    return
  }
  for (const key in obj) {
    if (key === 'meta' || key === 'value' || key === 'timestamp' || key === '$source' || key === 'notifications') continue
    walkForZones(obj[key], prefix + '.' + key, found)
  }
}

function walkForValuePaths(obj, prefix, found) {
  if (!obj || typeof obj !== 'object') return
  const cleanPath = prefix.replace(/^\./, '')
  if (cleanPath && Object.prototype.hasOwnProperty.call(obj, 'value')) found.push(cleanPath)
  for (const key in obj) {
    if (key === 'meta' || key === 'value' || key === 'timestamp' || key === '$source' || key === 'notifications') continue
    walkForValuePaths(obj[key], prefix + '.' + key, found)
  }
}

async function discoverZonedPaths() {
  // The vessel model changes dynamically. Do not allow the browser HTTP cache
  // to satisfy this request with the snapshot used by an earlier discovery.
  // A normal page reload naturally bypassed the stale snapshot, which is why
  // newly-online paths appeared only after reloading the browser.
  try {
    const response = await fetch(SELF_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache'
      }
    })
    if (!response.ok) throw new Error(`Error fetching vessel model: ${response.status} ${response.statusText}`)
    const vesselData = await response.json()
    const found = []
    const allPaths = []
    walkForZones(vesselData, '', found)
    walkForValuePaths(vesselData, '', allPaths)
    return { zoned: found, allPaths, vesselData }
  } catch (error) {
    console.error('[discovery] vessel model request failed:', error)
    return null
  }
}

function subscribePaths(entries) {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN || entries.length === 0) return
  const fresh = []
  entries.forEach(({ path, minPeriod, sendMeta }) => {
    if (subscribedPaths.has(path)) return
    subscribedPaths.add(path)
    const entry = { path, policy: 'instant' }
    if (minPeriod) entry.minPeriod = minPeriod
    if (sendMeta) entry.sendMeta = sendMeta
    fresh.push(entry)
  })
  if (fresh.length > 0) {
    liveSocket.send(JSON.stringify({ context: 'vessels.self', subscribe: fresh }))
  }
}


function addZonedPath(skPath, details = {}) {
  if (!skPath || typeof skPath !== 'string') return false

  const notifPath = notifPathForZonedPath(skPath)
  const wasKnown = zonedPaths.includes(skPath)
  if (!wasKnown) zonedPaths.push(skPath)
  knownModelPaths.add(skPath)

  if (!tableRows[notifPath]) {
    tableRows[notifPath] = { disabled: false, state: 'nominal' }
  }
  const row = tableRows[notifPath]
  if (persistedPathDisabled.get(notifPath) === true) row.disabled = true

  // A recent-clear event may have arrived before this dynamic zoned path was
  // discovered. Apply cached history only now, after legitimate discovery.
  if (!Number.isFinite(row.clearedAt)) {
    try {
      const saved = JSON.parse(localStorage.getItem(CLEAR_HISTORY_STORAGE_KEY) || '{}')
      const ts = saved[notifPath]
      if (Number.isFinite(ts) && Date.now() - ts >= 0 && Date.now() - ts < CLEAR_HISTORY_MAX_MS) {
        row.clearedAt = ts
      }
    } catch (_) {}
  }
  if (Object.prototype.hasOwnProperty.call(details, 'value')) row.value = details.value
  if (details.timestamp) row.timestamp = details.timestamp

  const meta = details.meta || details
  if (meta && typeof meta === 'object') {
    if (meta.units) row.units = meta.units
    if (meta.displayUnits) row.displayUnits = meta.displayUnits
  }

  // A newly-zoned path must become visible immediately. Do not wait for its
  // next sensor value or notification transition (some paths update very slowly).
  renderRow(notifPath, row)

  // renderRow/createTableRow can create a detached <tr>. Startup redraws later
  // append those rows via updateList(), but dynamically discovered paths do not
  // necessarily go through updateList(). Always attach the row here so the
  // shared addZonedPath() path is complete and event-driven.
  const domRow = document.getElementById('row-' + notifPath)
  if (domRow && table && domRow.parentNode !== table) {
    table.appendChild(domRow)
  }

  // Then arm both streams. Raw values are traffic-limited; notification
  // transitions remain immediate.
  subscribePaths([
    skPath === 'navigation.anchor.currentRadius'
      ? { path: skPath, sendMeta: 'all' }
      : { path: skPath, minPeriod: 1500, sendMeta: 'all' },
    { path: notifPath }
  ])

  return !wasKnown
}

function removeZonedPath(skPath) {
  if (!skPath || typeof skPath !== 'string') return
  const notifPath = notifPathForZonedPath(skPath)
  zonedPaths = zonedPaths.filter((p) => p !== skPath)
  delete tableRows[notifPath]
  const row = document.getElementById('row-' + notifPath)
  if (row) row.remove()
}

function desiredSubscriptionEntries() {
  const entries = [
    { path: playbackControlPrefix + '.disable' },
    { path: playbackControlPrefix + '.soundEvent' },
    { path: playbackControlPrefix + '.metaChanged' },
    { path: playbackControlPrefix + '.recentClear' },
    { path: playbackControlPrefix + '.pathDisabled' }
  ]
  zonedPaths.forEach((p) => {
    if (p === 'navigation.anchor.currentRadius') {
      entries.push({ path: p, sendMeta: 'all' })
    } else {
      entries.push({ path: p, minPeriod: 1500, sendMeta: 'all' })
    }
  })
  ALWAYS_SUBSCRIBE_RAW_PATHS.forEach((p) => entries.push({ path: p, minPeriod: 1500, sendMeta: 'all' }))
  Object.keys(tableRows).forEach((notifPath) => entries.push({ path: notifPath }))
  ALWAYS_SUBSCRIBE_NOTIF_PATHS.forEach((p) => entries.push({ path: p }))
  return entries
}

async function discoverAndSubscribe(reason = 'unspecified') {
  if (discoveryInProgress) {
    discoveryPending = true
    return null
  }
  discoveryInProgress = true
  try {
    const discovery = await discoverZonedPaths()
    if (discovery === null) {
      scheduleDiscoveryFallback('discovery request failed')
      return null
    }
    const found = discovery.zoned
    knownModelPaths = new Set(discovery.allPaths)
    const discovered = new Set(found.map((f) => f.path))
    const newRows = []

    found.forEach((f) => {
      const wasKnown = zonedPaths.includes(f.path)
      addZonedPath(f.path, {
        value: f.value,
        timestamp: f.timestamp,
        units: f.units,
        displayUnits: f.displayUnits
      })
      if (!wasKnown) newRows.push(notifPathForZonedPath(f.path))
    })

    // Keep the set deterministic and make the subscription set match discovery.
    zonedPaths = zonedPaths.filter((p) => discovered.has(p))

    subscribePaths(desiredSubscriptionEntries())
    if (newRows.length > 0) redrawTable()
    return { newRows: newRows.length, found: found.length }
  } finally {
    discoveryInProgress = false
    if (discoveryPending) {
      discoveryPending = false
      discoverAndSubscribe('pending discovery')
    }
  }
}

function handleMetadataEvent(value) {
  if (!value || value.type !== 'rescan') return
  discoverAndSubscribe('metadata event')
}

let announcedDiscoveryTimer = null
let announcedVerifyTimer = null

function inspectAnnouncedPath(skPath) {
  if (!startupDiscoveryComplete) return
  if (!skPath || skPath.startsWith('notifications.') || skPath.startsWith(playbackControlPrefix + '.')) return
  if (knownModelPaths.has(skPath)) return

  // Mark the announcement as known immediately so repeated values do not create
  // more timers. A burst of new paths produces one full-model discovery.
  knownModelPaths.add(skPath)

  if (!announcedDiscoveryTimer) {
    announcedDiscoveryTimer = setTimeout(() => {
      announcedDiscoveryTimer = null
      discoverAndSubscribe('new path announcement')
    }, 2000)
  }

  // Reset one shared verification timer for the whole burst.
  if (announcedVerifyTimer) clearTimeout(announcedVerifyTimer)
  announcedVerifyTimer = setTimeout(() => {
    announcedVerifyTimer = null
    discoverAndSubscribe('new path verification')
  }, 6000)
}

function armNewPathAnnouncements() {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN || newPathAnnouncementsArmed) return
  // Signal K announces cached paths once, then newly appearing paths. The
  // startup REST crawl supplies the baseline, so only genuinely new paths wake
  // the coalesced full-model zone discovery.
  liveSocket.send(JSON.stringify({
    context: 'vessels.self',
    announceNewPaths: true,
    subscribe: []
  }))
  newPathAnnouncementsArmed = true
}

// Full-model discovery is startup/recovery only. A 10-second fallback is armed
// only after an actual discovery request failure; healthy steady state has no
// recurring vessel-model GETs.
function scheduleDiscoveryFallback(reason) {
  if (discoveryFallbackTimer) return
  discoveryFallbackTimer = setTimeout(() => {
    discoveryFallbackTimer = null
    discoverAndSubscribe('10s failure fallback')
  }, 10000)
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectLiveSocket()
  }, 3000)
}

function connectLiveSocket() {
  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return

  const token = getAuthToken()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const tokenParam = token ? '&token=' + encodeURIComponent(token) : ''
  const socket = new WebSocket(`${proto}://${location.host}/signalk/v1/stream?subscribe=none${tokenParam}`)
  liveSocket = socket
  subscribedPaths = new Set()
  newPathAnnouncementsArmed = false

  socket.addEventListener('open', () => {
    if (socket !== liveSocket) return
    subscribePaths(desiredSubscriptionEntries())
    updateTimeStamp(true)
    if (hasConnectedOnce) {
      // We may have missed a new-path announcement while disconnected. One
      // catch-up model walk re-establishes the baseline before announcements are
      // re-armed; there is still no recurring discovery timer.
      discoverAndSubscribe('websocket reconnect catch-up').then(() => armNewPathAnnouncements())
    } else if (startupDiscoveryComplete) {
      armNewPathAnnouncements()
    }
    hasConnectedOnce = true
  })

  socket.addEventListener('message', (msg) => {
    if (socket !== liveSocket) return
    let delta
    try {
      delta = JSON.parse(msg.data)
    } catch (e) {
      return
    }
    if (!delta.updates) return
    updateTimeStamp(true)
    delta.updates.forEach((u) => {
      const ts = u.timestamp || new Date().toISOString()
      ;(u.values || []).forEach((v) => {
        // announceNewPaths uses ordinary value deltas for path announcements.
        // Only values from paths we explicitly subscribed to belong in the
        // table.  Otherwise the initial announcement burst would create rows
        // for every cached Signal K path, including paths with no zones.
        if (!v || typeof v.path !== 'string' || v.path.length === 0) {
          // Some server messages can contain a root/context value rather than a
          // leaf Signal K path.  Never turn that object into an empty table row.
          return
        }

        if (subscribedPaths.has(v.path)) {
          handleLiveValue(v.path, v.value, ts, v.meta)
          return
        }

        if (
          startupDiscoveryComplete &&
          !knownModelPaths.has(v.path) &&
          !v.path.startsWith('notifications.') &&
          !v.path.startsWith(playbackControlPrefix + '.')
        ) {
          inspectAnnouncedPath(v.path, v.value, ts, v.meta)
          return
        }

        // Known but non-subscribed paths are the initial announceNewPaths
        // baseline.  They are intentionally ignored: discovery already proved
        // they have no zones, so they must not become UI rows.
      })
    })
  })

  socket.addEventListener('close', (ev) => {
    if (socket !== liveSocket) return
    console.error('[live] socket CLOSED - code:', ev.code, 'reason:', ev.reason || '(none given)', 'wasClean:', ev.wasClean)
    liveSocket = null
    subscribedPaths = new Set()
    updateTimeStamp(false)
    scheduleReconnect()
  })

  socket.addEventListener('error', (ev) => {
    if (socket !== liveSocket) return
    console.error('[live] socket error event:', ev)
    socket.close()
  })
}

function handleLiveValue(path, value, timestamp, meta) {
  if (path === playbackControlPrefix + '.disable') {
    updateDisable = !!value
    applyPlaybackDisabledUI()
    return
  }

  if (path === playbackControlPrefix + '.soundEvent') {
    handleSoundEvent(value)
    return
  }

  if (path === playbackControlPrefix + '.metaChanged') {
    handleMetadataEvent(value)
    return
  }

  if (path === playbackControlPrefix + '.recentClear') {
    if (value && value.path && Number.isFinite(value.clearedAt)) {
      saveClearHistory(value.path, value.clearedAt)
      if (tableRows[value.path]) {
        tableRows[value.path].clearedAt = value.clearedAt
        renderRow(value.path, tableRows[value.path])
      }
    }
    return
  }

  if (path === playbackControlPrefix + '.pathDisabled') {
    if (value && typeof value.path === 'string') {
      if (value.disabled) persistedPathDisabled.set(value.path, true)
      else persistedPathDisabled.delete(value.path)
      if (tableRows[value.path]) {
        tableRows[value.path].disabled = !!value.disabled
        renderRow(value.path, tableRows[value.path])
      }
    }
    return
  }

  if (path.startsWith('notifications.')) {
    if (!value || typeof value.state === 'undefined') return
    if (!tableRows[path]) tableRows[path] = { disabled: false }
    const row = tableRows[path]
    const previousState = row.state

    if (isElevatedState(previousState) && isNormalState(value.state)) {
      // Exact in-session elevated -> normal transition.
      row.clearedAt = Date.now()
      saveClearHistory(path, row.clearedAt)
    } else if (typeof previousState === 'undefined' && isNormalState(value.state)) {
      // Initial-load approximation: use the current normal notification's
      // timestamp, except for the cluster generated when Signal K starts.
      const historyTimestamp = value.createdAt || value.timestamp || timestamp
      const ts = new Date(historyTimestamp).getTime()
      const age = Date.now() - ts
      if (!Number.isFinite(row.clearedAt) && Number.isFinite(ts) && age >= 0 && age < CLEAR_HISTORY_MAX_MS && !startupTimestamp(historyTimestamp)) {
        row.clearedAt = ts
        saveClearHistory(path, row.clearedAt)
      }
    } else if (isElevatedState(value.state)) {
      row.clearedAt = null
      saveClearHistory(path, null)
    }

    row.state = value.state
    row.previousState = previousState
    row.message = value.message
    row.id = value.id
    row.method = value.method
    if (value.status) row.status = value.status
    renderRow(path, row)

    if (path === 'notifications.navigation.anchor' && isNormalState(value.state)) {
      const anchorRow = tableRows['notifications.navigation.anchor']
      if (anchorRow) {
        anchorRow.value = null
        anchorRow.timestamp = timestamp
        renderRow('notifications.navigation.anchor', anchorRow)
      }
    }
    return
  }

  const notifPath = notifPathForZonedPath(path)
  if (!tableRows[notifPath]) tableRows[notifPath] = { disabled: false, state: 'nominal' }
  const row = tableRows[notifPath]
  const newTime = new Date(timestamp).getTime()
  const prevTime = row.timestamp ? new Date(row.timestamp).getTime() : null
  row.fastUpdating = prevTime !== null && newTime - prevTime >= 0 && newTime - prevTime < 15000
  row.ageToggleIndex = ((row.ageToggleIndex || 0) + 1) % SPINNER_FRAMES.length
  row.value = value
  row.timestamp = timestamp
  if (meta) {
    if (meta.units) row.units = meta.units
    if (meta.displayUnits) row.displayUnits = meta.displayUnits
  }
  renderRow(notifPath, row)
}

function waitForLiveSocketOpen(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (liveSocket && liveSocket.readyState === WebSocket.OPEN) return resolve(true)
    const socket = liveSocket
    if (!socket) return resolve(false)

    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('close', onClose)
      resolve(ok)
    }
    const onOpen = () => finish(true)
    const onClose = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('close', onClose)
  })
}

async function mergeServerClearHistory() {
  try {
    const response = await fetch(BASE_URL + '/recent-clears', { cache: 'no-store' })
    if (!response.ok) return
    const clears = await response.json()
    const now = Date.now()
    Object.entries(clears || {}).forEach(([path, ts]) => {
      if (Number.isFinite(ts) && now - ts >= 0 && now - ts < CLEAR_HISTORY_MAX_MS) {
        // Keep history cached, but do not manufacture a table row. Dynamic
        // paths must appear only after normal zone discovery sees them.
        saveClearHistory(path, ts)
        if (tableRows[path]) tableRows[path].clearedAt = ts
      }
    })
  } catch (_) {
    // History is optional; never block notification table startup.
  }
}

async function init() {
  initBrowserAudioUnlock()
  await fetchVesselName()

  try {
    const res = await fetch(BASE_URL + '/disable?-1')
    playbackControlPrefix = await res.json()
  } catch (error) {
    console.error('Fetching error:', error)
  }

  buildTableHeader()
  await fetchPersistedPathDisabled()
  loadClearHistory()
  mergeServerClearHistory()
  await fetchServerStartedAt()

  // Subscribe to metadata/path events before the initial crawl. This closes the
  // startup race: anything that appears while the crawl is in progress is still
  // delivered as a path-specific event afterward.
  connectLiveSocket()
  await waitForLiveSocketOpen()
  await discoverAndSubscribe('startup')
  startupDiscoveryComplete = true
  armNewPathAnnouncements()
  redrawTable()
  startRedrawTimer()
}

init()

function getAuthToken() {
  const raw = localStorage.getItem('authorization_token')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.token) return parsed.token
  } catch (e) {
    // not JSON - assume it's already a raw token string
  }
  return raw
}

let audioUnlocked = false
let currentAudio = null
let currentUtterance = null
let currentPlayingPath = null
let playQueue = []
let queuePlaying = false
let lastEventByPath = {}

function initBrowserAudioUnlock() {
  const btn = document.getElementById('enableBrowserAudio')
  if (!btn) return
  btn.addEventListener('click', () => {
    audioUnlocked = !audioUnlocked
    if (audioUnlocked) {
      try {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(' '))
      } catch (e) {}
      const a = new Audio()
      a.play().catch(() => {})
      btn.textContent = '🔊 Browser Audio: On'
    } else {
      playQueue = []
      lastEventByPath = {}
      stopCurrentPlayback()
      btn.textContent = '🔇 Browser Audio: Off'
    }
  })
}

function handleSoundEvent(evt) {
  if (!evt) return
  if (!audioUnlocked) return

  if (evt.kind === 'stop') {
    playQueue = []
    lastEventByPath = {}
    stopCurrentPlayback()
    return
  }

  if (evt.kind === 'stopPathNow') {
    dropPathFromQueue(evt.path)
    delete lastEventByPath[evt.path]
    return
  }

  if (evt.kind === 'stopPath') {
    delete lastEventByPath[evt.path]
    return
  }

  if (!evt.path || !evt.actions || evt.actions.length === 0) return

  const prev = lastEventByPath[evt.path]
  const isNewOccurrence = !prev || prev.gen !== evt.gen

  if (isNewOccurrence) {
    dropPathFromQueue(evt.path)
    lastEventByPath[evt.path] = { gen: evt.gen, mode: evt.mode }
  } else if (evt.mode !== 'continuous') {
    return
  }

  evt.actions.forEach((action) => playQueue.push({ ...action, path: evt.path, gen: evt.gen }))
  if (!queuePlaying) drainPlayQueue()
}

function dropPathFromQueue(path) {
  playQueue = playQueue.filter((a) => a.path !== path)
  if (currentPlayingPath === path) {
    stopCurrentPlayback()
    drainPlayQueue()
  }
}

function stopCurrentPlayback() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
  window.speechSynthesis.cancel()
  currentUtterance = null
  currentPlayingPath = null
  queuePlaying = false
}

function drainPlayQueue() {
  const action = playQueue.shift()
  if (!action) {
    queuePlaying = false
    currentPlayingPath = null
    return
  }
  queuePlaying = true
  currentPlayingPath = action.path

  if (action.kind === 'sound' && action.url) {
    currentAudio = new Audio(action.url)
    currentAudio.addEventListener('ended', drainPlayQueue)
    currentAudio.addEventListener('error', (e) => {
      console.error('[soundEvent] Audio ERROR for', action.url, '- element error:', currentAudio && currentAudio.error, e)
      drainPlayQueue()
    })
    currentAudio.play().catch((err) => {
      console.error('[soundEvent] Audio.play() REJECTED for', action.url, ':', err)
      drainPlayQueue()
    })
  } else if (action.kind === 'speech' && action.text) {
    if (!('speechSynthesis' in window)) {
      console.error('[soundEvent] speechSynthesis not supported in this browser')
      drainPlayQueue()
      return
    }
    currentUtterance = new SpeechSynthesisUtterance(action.text)
    currentUtterance.onend = drainPlayQueue
    currentUtterance.onerror = (e) => {
      console.error('[soundEvent] speechSynthesis ERROR:', e.error, e)
      drainPlayQueue()
    }
    window.speechSynthesis.speak(currentUtterance)
  } else {
    drainPlayQueue()
  }
}
