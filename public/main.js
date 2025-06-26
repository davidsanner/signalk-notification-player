//
//  signalk-notifcation-player webapp
//
const BASE_URL = '/plugins/signalk-notification-player'
const SELF_URL = '/signalk/v1/api/vessels/self'
const CONFIG_URL = '/admin/#/serverConfiguration/plugins/signalk-notification-player'
let popupActive = false // keep popup data from reloading when main table reloads
let popupActiveState = false // keep popup data from reloading when main table reloads
let vesselName = ''
let zones = ''
let listEntries = 0
let updateInterval = 2
let updateTimer
let updateDisable = false
let playbackControlPath = ''

const table = document.createElement('table')
const headerRow = document.createElement('tr')
const bgColorList = {
  emergency: '#ff0000',
  alarm: '#ff5555',
  warn: 'yellow',
  alert: 'olive',
  normal: '#b6c6b0',
  nominal: '#9bb194'
}
const listContent = document.getElementById('list-div')
listContent.innerHTML = ''

headerRow.innerHTML =
  '<th style="font-size: large">' +
  vesselName +
  ' Notifications</th><th>Value</th><th>Age<br></th><th>State</th><th>Disable</th><th span=2><button id=silenceAll>Silence All</button></th>'
table.appendChild(headerRow)
listContent.appendChild(table)
document.getElementById(`silenceAll`).addEventListener('click', processSilence)
document.getElementById('playbackDisabled').addEventListener('click', processDisable)
document.getElementById('playbackDisabled').checked = updateDisable

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

function updateList(data) {
  let age
  statusElement = document.getElementById('overlay')
  if (updateDisable == true) {
    listContent.style.opacity = '.5'
    statusElement.style.display = 'flex'
    statusElement.textContent = 'Notification Playback Disabled'
    document.getElementById('playbackDisabled').checked = true
  } else {
    listContent.style.opacity = '1'
    statusElement.style.display = 'none'
  }

  Object.entries(data).forEach(([path, value]) => {
    let pathVal, pathUnits
    if (!(row = document.getElementById('row-' + path))) {
      row = document.createElement('tr')
      row.setAttribute('id', 'row-' + path)
    }
    let bgc = bgColorList[value.state]
    if (typeof bgc == 'undefined') bgc = '#BBB'
    const state = value.state
    let bgAge = 'style="color:#666"'
    pathTrimmed = path.substring(path.indexOf('.') + 1)
    if (typeof value.value !== 'undefined') {
      pathVal = value.value
      pathUnits = value.units
      if (pathVal == null) {
        pathVal = 'n/a'
        pathUnits = ''
      } else if (pathVal == true || pathVal == false) {
        pathUnits = ''
      } else {
        if (!pathUnits) pathUnits = ''
        else if (pathUnits == 'K') {
          pathUnits = 'C'
          pathVal = pathVal - 273.15
        }
        pathVal = pathVal.toPrecision(3)
        if (pathVal == 0.0) pathVal = 0
        else if (pathVal == 1.0) pathVal = 1
      }

      age = (Date.now() - new Date(value.timestamp).getTime()) / 1000
      age = Math.trunc(age)
      if (age > 60) bgAge = 'style="color: #C04000; font-weight: bold;"'
      else if (age > 15) bgAge = 'style="color: #7E3817; font-weight: bold;"'
      if (age > 7200) age = Math.trunc(age / 3600) + 'h'
      else age = ' ' + age + 's'
    } else {
      pathVal = 'error'
      pathUnits = ''
      age = '-'
    }
    if (value.disabled) disabledStyle = 'background-color: #7E3817'
    else disabledStyle = ''

    row.innerHTML = `<td id="${pathTrimmed}" style="${disabledStyle}">${pathTrimmed}</td><td>${pathVal} ${pathUnits}</td><td ${bgAge}>${age}</td><td id="${pathTrimmed}-state" bgcolor="${bgc}">${state}</td><td><input id=${path}-disabled type="checkbox"}></td><td><button id="${path}-silence">Silence</button>&nbsp;&nbsp;<button id="${path}-resolve">Resolve</button></td>`
    table.appendChild(row)
    document.getElementById((id = path + '-disabled')).checked = value.disabled
  })

  Object.entries(data).forEach(([path, value]) => {
    pathTrimmed = path.substring(path.indexOf('.') + 1)
    if (document.getElementById(`${path}-resolve`))
      document.getElementById(`${path}-resolve`).addEventListener('click', processResolve)
    if (document.getElementById(`${path}-silence`))
      document.getElementById(`${path}-silence`).addEventListener('click', processSilence)
    document.getElementById(`${path}-disabled`).addEventListener('click', processPathDisable)
    document.getElementById(pathTrimmed).addEventListener('mouseout', function () {
      document.getElementById('popupContent').style.display = 'none'
      popupActive = false
      fetchAndUpdateList()
    })
    document.getElementById(pathTrimmed+"-state").addEventListener('mouseout', function () {
      document.getElementById('popupContentState').style.display = 'none'
      popupActiveState = false
      fetchAndUpdateList()
    })
    if (!popupActive) {
      document.getElementById(pathTrimmed).addEventListener('mouseover', processMouseOver)
    }
    if (!popupActiveState) {
      document.getElementById(pathTrimmed+"-state").addEventListener('mouseover', processMouseOverState)
    }
  })
}

function processMouseOver(event) {
  popupActive = true
  if (event.target.id.includes('navigation.anchor'))
    zonePath = SELF_URL + '/' + event.target.id.replaceAll('.', '/') + '/meta/value/zones'
  // support for anchor api w/ different path?
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
  maxShown = 8
  popupActiveState = true
  path = event.target.id.substring(0,event.target.id.indexOf('-'))
  document.getElementById('popupContentState').innerHTML =
    'Last Notification:&nbsp;<div style="display:inline; font-size: small; color:#800;">' + path +
    '</div><hr><div id=zonesState>loading...</div>'
  document.getElementById('popupContentState').style.display = 'block'
  getJSON(BASE_URL + '/log?' + "notifications." + path + "?" + maxShown).then(data => {
      if (data.includes('Cannot GET ')) document.getElementById('zonesState').innerHTML = '---'
      text = JSON.stringify(data)
      text = text.replaceAll('},{', '}<hr>{')
      text = text.replace(/[\[\]]/g, '')
      let html = "<table>"
      for (const item of data) {
        if(typeof item.value === 'number') item.value = item.value.toPrecision(5)
        html += "<tr><td>State: "+item.state+"</td><td>Value: "+item.value+"</td><td>Since: "+formattedDT(new Date(item.datetime))+"</td></tr>";
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

async function fetchAndUpdateList() {
  fetchStatus()
  const data = await getJSON(BASE_URL + '/list')
  if (data) {
    if (!listEntries)
      Object.entries(data).forEach(([path, value]) => {
        listEntries++
      })
    if (listEntries) {
      updateList(data)
    }
    updateTimeStamp(true)
  } else updateTimeStamp(false)
}

async function fetchVesselName() {
  const data = await getJSON(SELF_URL + '/name')
  if (data) vesselName = data + ' :'
}

async function fetchStatus() {
  if (playbackControlPath == '') {
    // 1st time through get playbackControlPrefix from plugin config
    try {
      const res1 = await fetch(BASE_URL + '/disable?-1')
      const urlpath = await res1.json()

      playbackControlPath = SELF_URL + '/' + urlpath.replaceAll('.', '/') + '/disable'
      const res2 = await fetch(playbackControlPath)

      updateDisable = (await res2.json()).value
    } catch (error) {
      console.error('Fetching error:', error)
    }
  } else {
    try {
      const res2 = await fetch(playbackControlPath)
      updateDisable = (await res2.json()).value
    } catch (error) {
      console.error('Fetching error:', error)
    }
  }
}

function processResolve(event) {
  processNotification(BASE_URL + '/resolve?' + event.target.id.split('-')[0])
  fetchAndUpdateList()
}

function processSilence(event) {
  if (event.target.id == 'silenceAll') processNotification(BASE_URL + '/silence')
  else processNotification(BASE_URL + '/silence?' + event.target.id.split('-')[0])
}

function processDisable(event) {
  startTimer() // restart time so page doesn't reload while processing event
  if (event.explicitOriginalTarget.checked) {
    updateDisable = true
    processNotification(BASE_URL + '/disable')
  } else {
    updateDisable = false
    processNotification(BASE_URL + '/disable?0')
  }
  setTimeout(fetchAndUpdateList, 200)
}

function processPathDisable(event) {
  startTimer() // restart timer so page doesn't reload while processing event
  processNotification(BASE_URL + '/disablePath?' + event.target.id.split('-')[0] + '?' + event.target.checked)
  setTimeout(fetchAndUpdateList, 100)
}

document.getElementById('update-timer').addEventListener('input', (event) => {
  updateInterval = parseInt(event.target.value, 10) || 2
  startTimer()
})

function startTimer() {
  if (updateTimer) clearInterval(updateTimer)
  updateTimer = setInterval(fetchAndUpdateList, updateInterval * 1000)
}

// start up
fetchStatus()
fetchVesselName()
fetchAndUpdateList()
startTimer()
