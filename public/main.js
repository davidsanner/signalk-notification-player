let updateInterval = 2
let updateTimer
const BASE_URL = "/plugins/signalk-notification-player" 
const NAME_URL = "/signalk/v1/api/vessels/self/name"
const CONFIG_URL = "/admin/#/serverConfiguration/plugins/signalk-notification-player"
let vesselName = ''
let listEntries = 0

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
    console.error("Error:", error)
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
    console.error("Error:", error)
    return null
  }
}

function updateMetadata() {
  const now = new Date()
  document.getElementById('timestamp').textContent = now.toLocaleTimeString()
}

function updateList(data) {
  const bgColorList = {'emergency': '#ff0000', 'alarm': '#ff5555', 'warn': 'yellow', 'alert': 'olive', 'normal': '#b6c6b0', 'nominal': '#9bb194'}
  const listContent = document.getElementById('list-div')
  let age 
  listContent.innerHTML = ''

  const table = document.createElement('table')
  const headerRow = document.createElement('tr')
  headerRow.innerHTML = '<th style="font-size: large">'+vesselName+' Notifications</th><th>Value</th><th>Age<br></th><th>State</th><th span=2><button id=silenceAll>Silence All</button></th>'
  table.appendChild(headerRow)

  Object.entries(data).forEach(([path, value]) => {
    let pathVal, pathUnits
    const row = document.createElement('tr')
    const bgc = bgColorList[value.state]
    const state = value.state
    let bgcAge = '#dde5db'
    pathVal = value.value
    if ( typeof value.value !== "undefined" ) {
      if ( pathVal == 0.000 ) pathVal = 0 
      pathUnits = value.units
      if (pathUnits == 'K') {
        pathUnits = 'C'
        pathVal = pathVal - 273.15
      }
      pathVal = pathVal.toPrecision(3)
      if( !pathUnits ) pathUnits = ''

      age = ((Date.now() - new Date(value.timestamp).getTime())/1000)
      age = Math.trunc(age)
      if ( age > 60 ) bgcAge = bgColorList['warn']
      else if ( age > 15 ) bgcAge = bgColorList['alert']
      if( age > 7200 ) age = Math.trunc(age/3600)+"h"
      else age = " "+age+"s"

    } else {
      pathVal = ""
      pathUnits = "n/a"
      age = ' - '
    }
    row.innerHTML = `<td>${path}</td><td>${pathVal} ${pathUnits}</td><td bgcolor="${bgcAge}">${age}</td><td bgcolor="${bgc}">${state}</td><td><button id="${path}-silence">Silence</button>&nbsp;&nbsp;<button id="${path}-resolve">Resolve</button></td>`
    table.appendChild(row)
  })
  listContent.appendChild(table)

  Object.entries(data).forEach(([path, value]) => {
    document.getElementById(`${path}-resolve`).addEventListener('click', processResolve)
    document.getElementById(`${path}-silence`).addEventListener('click', processSilence)
  })
  document.getElementById(`silenceAll`).addEventListener('click', processSilence)
}
async function fetchAndUpdateList() {
  const data = await getJSON(BASE_URL+'/list') 
  if (data) {
    if (!listEntries) Object.entries(data).forEach(([path, value]) => { listEntries++ })  // initial check for avail notifications, if none leave default html
    if (listEntries) {
      updateList(data)
    }
  }
  updateMetadata()
}

async function fetchVesselName() {
  const data = await getJSON(NAME_URL) 
  if (data) vesselName = data+" :"
}

function startTimer() {
  if (updateTimer) clearInterval(updateTimer)
  updateTimer = setInterval(fetchAndUpdateList, updateInterval * 1000)
}

function processResolve(event) {
   processNotification(BASE_URL+'/resolve?'+event.target.id.split('-')[0])
   fetchAndUpdateList()
}

function processSilence(event) {
   if(event.target.id == 'silenceAll')
     processNotification(BASE_URL+'/silence')
   else
     processNotification(BASE_URL+'/silence?'+event.target.id.split('-')[0])
}

document.getElementById('update-timer').addEventListener('input', (event) => {
  updateInterval = parseInt(event.target.value, 10) || 2
  startTimer()
})


// start up 
fetchVesselName()
fetchAndUpdateList()
startTimer()

