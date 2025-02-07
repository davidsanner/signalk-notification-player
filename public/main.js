//
//  signalk-notifcation-player webapp
//
const BASE_URL = "/plugins/signalk-notification-player" 
const SELF_URL = "/signalk/v1/api/vessels/self"
const CONFIG_URL = "/admin/#/serverConfiguration/plugins/signalk-notification-player"
let popupActive = false  // keep popup data from reloading when main table reloads
let vesselName = ''
let zones = ''
let listEntries = 0
let updateInterval = 2
let updateTimer

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

function updateTimeStamp(status) {
  const now = new Date()
  if( status )
    document.getElementById('timestamp').textContent = now.toLocaleTimeString()
  else {
    const errMsg = document.getElementById('timestamp')
    errMsg.innerHTML = '<div style="font-size: x-large; color:#F00;">COMMUNICATION ERROR</div>'
  }
}

function updateList(data) {
  const bgColorList = {'emergency': '#ff0000', 'alarm': '#ff5555', 'warn': 'yellow', 'alert': 'olive', 'normal': '#b6c6b0', 'nominal': '#9bb194'}
  const listContent = document.getElementById('list-div')
  let age 
  listContent.innerHTML = ''

  const table = document.createElement('table')
  const headerRow = document.createElement('tr')
  headerRow.innerHTML = '<th style="font-size: large">'+vesselName+
       ' Notifications</th><th>Value</th><th>Age<br></th><th>State</th><th span=2><button id=silenceAll>Silence All</button></th>'
  table.appendChild(headerRow)

  Object.entries(data).forEach(([path, value]) => {
    let pathVal, pathUnits
    const row = document.createElement('tr')
    const bgc = bgColorList[value.state]
    const state = value.state
    let bgAge = 'style="color:#666"'
    pathTrimmed = path.substring(path.indexOf(".") + 1);
    if ( typeof value.value !== "undefined" ) {
      pathVal = value.value
      pathUnits = value.units
      if(pathVal == null) {
        pathVal = 'n/a'
        pathUnits = ''
      }
      else {
        if( !pathUnits ) pathUnits = ''
        else if (pathUnits == 'K') {
          pathUnits = 'C'
          pathVal = pathVal - 273.15
        }
        pathVal = pathVal.toPrecision(3)
        if ( pathVal == 0.000 ) pathVal = 0 
        else if ( pathVal == 1.000 ) pathVal = 1 
      }

      age = ((Date.now() - new Date(value.timestamp).getTime())/1000)
      age = Math.trunc(age)
      if ( age > 60 ) bgAge = 'style="color: #C04000; font-weight: bold;"'
      else if ( age > 15 ) bgAge = 'style="color: #7E3817; font-weight: bold;"'
      if( age > 7200 ) age = Math.trunc(age/3600)+"h"
      else age = " "+age+"s"

    } else { 
      pathVal = "error"
      pathUnits = ""
      age = '-'
    }

    row.innerHTML = `<td id="${pathTrimmed}">${pathTrimmed}</td><td>${pathVal} ${pathUnits}</td><td ${bgAge}>${age}</td><td bgcolor="${bgc}">${state}</td><td><button id="${path}-silence">Silence</button>&nbsp;&nbsp;<button id="${path}-resolve">Resolve</button></td>`
    table.appendChild(row)
  })
  listContent.appendChild(table)

  Object.entries(data).forEach(([path, value]) => {
    pathTrimmed = path.substring(path.indexOf(".") + 1);
    if(document.getElementById(`${path}-resolve`)) document.getElementById(`${path}-resolve`).addEventListener('click', processResolve)
    if(document.getElementById(`${path}-silence`)) document.getElementById(`${path}-silence`).addEventListener('click', processSilence)
    document.getElementById(pathTrimmed).addEventListener('mouseout', function(){document.getElementById('popupContent').style.display = 'none'; popupActive = false ; fetchAndUpdateList()})
    if(!popupActive) {
    document.getElementById(pathTrimmed).addEventListener('mouseover', processMouseOver)
    }
  })
  document.getElementById(`silenceAll`).addEventListener('click', processSilence)
}

function processMouseOver(event) {
  popupActive = true
  if (event.target.id.includes("navigation.anchor"))
    zonePath = SELF_URL+"/"+event.target.id.replaceAll('.', '/')+"/meta/value/zones"  // support for anchor api w/ different path?
  else
    zonePath = SELF_URL+"/"+event.target.id.replaceAll('.', '/')+"/meta/zones"
  fetch(zonePath)
    .then(response => response.text())
    .then(text => {
      text = text.replaceAll('},{','}<hr>{')
      text = text.replace(/[\[\]]/g, "")
      if(text.includes('Cannot GET ')) document.getElementById('zones').innerHTML = '---'
      else document.getElementById('zones').innerHTML = text
    })
    .catch(error => {
      //console.error('Error:', error);
    });

  document.getElementById('popupContent').innerHTML = 'Zone MetaData for:&nbsp;<div style="display:inline; font-size: medium; color:#800;">'+event.target.id+'</div><hr><div id=zones>loading zones...</div>'
  document.getElementById('popupContent').style.display = 'block';
}

async function fetchAndUpdateList() {
  const data = await getJSON(BASE_URL+'/list') 
  if (data) {
    if (!listEntries) Object.entries(data).forEach(([path, value]) => { listEntries++ }) 
    if (listEntries) {
      updateList(data)
    }
    updateTimeStamp(true)
  }
  else
    updateTimeStamp(false)
}

async function fetchVesselName() {
  const data = await getJSON(SELF_URL+"/name") 
  if (data) vesselName = data+" :"
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

function startTimer() {
  if (updateTimer) clearInterval(updateTimer)
  updateTimer = setInterval(fetchAndUpdateList, updateInterval * 1000)
}

// start up 
fetchVesselName()
fetchAndUpdateList() 
startTimer()

