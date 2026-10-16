// Alerte créneaux Paris Tennis — Mourlon (15e) et Montherlant (16e).
// Les demandes sont des tickets GitHub (ex. "ven 23/10 17h"). Quand un court se libère,
// le robot commente le ticket (GitHub t'envoie un mail) et envoie une notif ntfy.
// Il ne réserve rien. Chargement du planning repris de par-ici-tennis (licence MIT).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import {
  parseRequest, daysFromToday, describeRequest, parisNow, matchLocations,
  filterSlots, slotKey, newSlots, buildMessage,
} from './lib/logic.js'

// ---------- Réglages ----------
const CENTRES = ['mourlon', 'montherlant'] // mots-clés cherchés dans l'annuaire officiel
const LIEN_RESA = 'https://tennis.paris.fr/tennis/'
const STATE_FILE = 'state/seen.json'
const ERROR_REPEAT_HOURS = 6               // une alerte d'erreur max toutes les 6 h
// ------------------------------

const LOCATIONS_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennisParisien&view=les_tennis_parisiens'
const START_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1'
const PLANNING_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&action=ajax_load_planning'

const {
  ACCOUNT_EMAIL, ACCOUNT_PASSWORD, NTFY_TOPIC, GITHUB_TOKEN, GITHUB_REPOSITORY, REPO_OWNER,
} = process.env
const TEST_MODE = process.argv.includes('--test-notif')

// ---------- Notifications ----------
const notify = async ({ title, message, priority = 4, tags = ['tennis'] }) => {
  if (!NTFY_TOPIC) return
  const response = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: NTFY_TOPIC, title, message, priority, tags, click: LIEN_RESA }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`ntfy a répondu HTTP ${response.status}`)
}

// ---------- Tickets GitHub ----------
const github = async (path, options = {}) => {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
  })
  if (!response.ok) throw new Error(`GitHub ${path} : HTTP ${response.status}`)
  return response.json()
}

const openRequests = async () => {
  const issues = await github(`/issues?state=open&per_page=50&creator=${REPO_OWNER}`)
  return issues.filter(issue => !issue.pull_request)
}
const comment = (number, body) => github(`/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
const close = number => github(`/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) })

// ---------- Mémoire entre deux passages ----------
const loadState = async () => {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return { issues: state.issues || {}, lastErrorAt: state.lastErrorAt || null }
  } catch {
    return { issues: {}, lastErrorAt: null }
  }
}
const saveState = async state => {
  await mkdir('state', { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

// ---------- Paris Tennis ----------
const login = async browser => {
  if (!ACCOUNT_EMAIL || !ACCOUNT_PASSWORD) {
    throw new Error('Secrets ACCOUNT_EMAIL / ACCOUNT_PASSWORD manquants dans GitHub.')
  }
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)
  await page.goto(START_URL)
  await page.click('#button_suivi_inscription')
  await page.fill('#username', ACCOUNT_EMAIL)
  await page.fill('#password', ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')
  try {
    await page.waitForSelector('.main-informations', { timeout: 45000 })
  } catch {
    throw new Error('Connexion à Paris Tennis impossible (identifiants refusés, ou vérification anti-robot demandée).')
  }
  return page
}

const officialLocationNames = async page => {
  await page.goto(LOCATIONS_URL)
  const html = await page.content()
  const marker = html.search(/var\s+tennis\s*=/)
  if (marker < 0) throw new Error('Annuaire des tennis introuvable (le site a peut-être changé).')
  const start = html.indexOf('{', marker)
  let depth = 0; let inString = false; let escaped = false
  for (let i = start; i < html.length; i += 1) {
    const c = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}' && --depth === 0) {
      const directory = JSON.parse(html.slice(start, i + 1))
      return [...new Set(directory.features.map(f => f.properties.general._nomSrtm))]
    }
  }
  throw new Error('Annuaire des tennis illisible (le site a peut-être changé).')
}

const readPlanning = async (page, location, date) => {
  const response = await page.context().request.post(PLANNING_URL, {
    form: { date_selected: date, name_tennis: location },
  })
  if (!response.ok()) throw new Error(`Planning ${location} ${date} : HTTP ${response.status()}`)
  const html = await response.text()
  if (html.includes('Aucun créneau pour la date sélectionnée')) return []

  await page.setContent(html)
  if (await page.locator('table.reservation').count() === 0) {
    throw new Error(`Planning ${location} ${date} : tableau absent (le site a peut-être changé).`)
  }
  const { courts, rows } = await page.locator('table.reservation').evaluate(table => {
    const courts = [...table.querySelectorAll('thead tr:last-child th:not(:first-child)')].map(th => {
      const tip = document.createElement('div')
      tip.innerHTML = th.querySelector('[data-content]')?.getAttribute('data-content') || ''
      return { name: th.querySelector('.title')?.textContent || '', type: tip.querySelector('span')?.textContent || '' }
    })
    const rows = [...table.querySelectorAll('tbody tr')].map(tr => {
      const cells = [...tr.querySelectorAll('td')]
      return {
        time: cells[0]?.innerText || '',
        statuses: cells.slice(1).map(td => (td.querySelector('.title-cell') || td.querySelector('span'))?.innerText || ''),
      }
    })
    return { courts, rows }
  })

  const clean = s => (s || '').trim().replace(/\s+/g, ' ')
  return rows.flatMap(row => row.statuses.map((status, i) => ({
    location,
    date,
    time: clean(row.time),
    court: clean(courts[i]?.name),
    courtType: clean(courts[i]?.type),
    status: clean(status).toUpperCase(),
  })))
}

const openingLabel = date => {
  const [dd, mm, yyyy] = date.split('/').map(Number)
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd - 6, 12))
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}`
}

// ---------- Passage ----------
const run = async () => {
  if (TEST_MODE) {
    await notify({ title: '🎾 Test réussi', message: 'Les alertes tennis arriveront ici.', priority: 3 })
    console.log('Notification de test envoyée.')
    return
  }

  const state = await loadState()
  const issues = await openRequests()
  const known = {}
  const active = []
  const currentHour = parisNow().hour

  for (const issue of issues) {
    const previous = state.issues[issue.number] || {}
    const request = parseRequest(issue.title)

    if (request.error) {
      if (previous.errorTitle !== issue.title) {
        await comment(issue.number, `🤔 Je n'ai pas compris cette demande : ${request.error}.\n\nModifie le titre du ticket, par exemple \`ven 23/10 17h\`, \`vendredi 17h-19h\` ou \`demain 18h 19h\`.`)
      }
      known[issue.number] = { errorTitle: issue.title }
      continue
    }

    const key = `${request.date}|${request.hours.join(',')}`
    const delta = daysFromToday(request.date)
    const over = delta < 0 || (delta === 0 && Math.max(...request.hours) <= currentHour)
    if (over) {
      await comment(issue.number, '⏱️ Ce créneau est passé, je ferme la demande.')
      await close(issue.number)
      console.log(`#${issue.number} : date passée, ticket fermé.`)
      continue
    }

    const entry = previous.key === key ? previous : { key, seen: [] }
    if (!entry.acked) {
      let body = `✅ Bien reçu. Je surveille **Mourlon (15e)** et **Montherlant (16e)** pour le **${describeRequest(request)}**.\n\nJe commente ici dès qu'un court se libère : tu reçois un mail à chaque fois. Ferme le ticket quand tu as réservé.`
      if (delta > 6) body += `\n\n📅 Les réservations pour ce jour ouvrent le ${openingLabel(request.date)} à 8h. Je commence la surveillance à ce moment-là.`
      await comment(issue.number, body)
      entry.acked = true
    }
    known[issue.number] = entry
    if (delta <= 6) active.push({ issue, request, entry })
  }

  state.issues = known
  if (active.length === 0) {
    console.log(`${issues.length} demande(s) ouverte(s), aucune dans les 7 jours réservables : rien à vérifier.`)
    await saveState(state)
    return
  }

  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await login(browser)
    console.log('Connecté à Paris Tennis.')
    const locations = matchLocations(await officialLocationNames(page), CENTRES)

    const dates = [...new Set(active.map(a => a.request.date))]
    const slotsByDate = {}
    for (const date of dates) {
      slotsByDate[date] = []
      for (const location of locations) {
        slotsByDate[date].push(...await readPlanning(page, location, date))
        await page.waitForTimeout(1500) // on reste poli avec le site
      }
    }

    for (const { issue, request, entry } of active) {
      const libres = filterSlots(slotsByDate[request.date], request.hours)
      const nouveaux = newSlots(libres, entry.seen)
      console.log(`#${issue.number} ${describeRequest(request)} : ${libres.length} libre(s), ${nouveaux.length} nouveau(x).`)
      if (nouveaux.length > 0) {
        const { title, message } = buildMessage(nouveaux)
        const lines = message.split('\n').map(line => `- ${line}`).join('\n')
        await comment(issue.number, `🎾 **Libre maintenant :**\n${lines}\n\n👉 [Réserver sur Paris Tennis](${LIEN_RESA}). Premier arrivé, premier servi.`)
        await notify({ title, message }).catch(e => console.error(`ntfy : ${e.message}`))
      }
      entry.seen = libres.map(slotKey) // un court repris puis relibéré sera re-signalé
    }
    state.lastErrorAt = null
  } catch (error) {
    console.error(`ERREUR : ${error.message}`)
    const last = state.lastErrorAt ? new Date(state.lastErrorAt) : null
    if (!last || Date.now() - last.getTime() > ERROR_REPEAT_HOURS * 3600e3) {
      for (const { issue } of active) {
        await comment(issue.number, `⚠️ Je n'arrive pas à vérifier les créneaux en ce moment : ${error.message}`).catch(() => {})
      }
      await notify({ title: '⚠️ Alerte tennis en panne', message: error.message, priority: 2, tags: ['warning'] })
        .catch(e => console.error(`ntfy : ${e.message}`))
      state.lastErrorAt = new Date().toISOString()
    }
    process.exitCode = 1
  } finally {
    await saveState(state)
    await browser?.close()
  }
}

run().catch(error => {
  console.error(`ERREUR : ${error.message}`)
  process.exitCode = 1
})
