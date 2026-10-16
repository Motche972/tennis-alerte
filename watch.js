// Alerte créneaux Paris Tennis — Mourlon (15e) et Montherlant (16e), 18h et 19h, 7 jours visibles.
// Ne réserve rien : lit le planning et envoie une notification ntfy pour chaque nouveau créneau libre.
// Endpoint et parsing du planning repris du projet open source par-ici-tennis (licence MIT).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import {
  planningDates, matchLocations, filterSlots, slotKey, newSlots, buildMessage,
} from './lib/logic.js'

// ---------- Réglages ----------
const CENTRES = ['mourlon', 'montherlant'] // mots-clés cherchés dans l'annuaire officiel
const HEURES = [18, 19]                    // heures de début de créneau surveillées
const LIEN_RESA = 'https://tennis.paris.fr/tennis/'
const STATE_FILE = 'state/seen.json'
const ERROR_REPEAT_HOURS = 6               // une alerte d'erreur max toutes les 6 h
// ------------------------------

const LOCATIONS_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennisParisien&view=les_tennis_parisiens'
const START_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1'
const PLANNING_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&action=ajax_load_planning'

const { ACCOUNT_EMAIL, ACCOUNT_PASSWORD, NTFY_TOPIC } = process.env
const TEST_MODE = process.argv.includes('--test-notif')

const notify = async ({ title, message, priority = 4, tags = ['tennis'] }) => {
  if (!NTFY_TOPIC) throw new Error('Secret NTFY_TOPIC manquant.')
  const response = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: NTFY_TOPIC, title, message, priority, tags, click: LIEN_RESA }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`ntfy a répondu HTTP ${response.status}`)
}

const loadState = async () => {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    return { seen: [], lastErrorAt: null }
  }
}

const saveState = async state => {
  await mkdir('state', { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

const login = async browser => {
  if (!ACCOUNT_EMAIL || !ACCOUNT_PASSWORD) {
    throw new Error('Secrets ACCOUNT_EMAIL / ACCOUNT_PASSWORD manquants.')
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
  if (marker < 0) throw new Error("Annuaire des tennis introuvable (le site a peut-être changé).")
  // Lecture du JSON "var tennis = {...}" en comptant les accolades
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
  throw new Error("Annuaire des tennis illisible (le site a peut-être changé).")
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

const run = async () => {
  if (TEST_MODE) {
    await notify({ title: '🎾 Test réussi', message: 'Les alertes tennis arriveront ici.', priority: 3 })
    console.log('Notification de test envoyée.')
    return
  }

  const state = await loadState()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await login(browser)
    console.log('Connecté à Paris Tennis.')
    const locations = matchLocations(await officialLocationNames(page), CENTRES)
    console.log(`Centres surveillés : ${locations.join(', ')}`)

    const all = []
    for (const location of locations) {
      for (const { label, weekday } of planningDates()) {
        if (weekday === 0) continue // dimanche : fermeture à 18h, pas de créneau 18h/19h
        all.push(...await readPlanning(page, location, label))
        await page.waitForTimeout(1500) // on reste poli avec le site
      }
    }

    const libres = filterSlots(all, HEURES)
    const nouveaux = newSlots(libres, state.seen)
    console.log(`${all.length} cases lues, ${libres.length} libre(s) à 18h/19h, ${nouveaux.length} nouveau(x).`)

    if (nouveaux.length > 0) {
      await notify(buildMessage(nouveaux))
      console.log('Notification envoyée :\n' + buildMessage(nouveaux).message)
    }

    // On mémorise ce qui est libre maintenant : un créneau repris puis relibéré sera re-signalé
    await saveState({ seen: libres.map(slotKey), lastErrorAt: null })
  } catch (error) {
    console.error(`ERREUR : ${error.message}`)
    const last = state.lastErrorAt ? new Date(state.lastErrorAt) : null
    if (!last || Date.now() - last.getTime() > ERROR_REPEAT_HOURS * 3600e3) {
      await notify({ title: '⚠️ Alerte tennis en panne', message: error.message, priority: 2, tags: ['warning'] })
        .catch(e => console.error(`ntfy : ${e.message}`))
      state.lastErrorAt = new Date().toISOString()
    }
    await saveState(state)
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}

run()

