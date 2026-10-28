# Backpack Hero Junior Company: Website

Ordnung, die mitgeht. Website der Backpack Hero Junior Company (Schulprojekt im Rahmen von Junior Achievement Austria, HTL Vöcklabruck).

## Aufbau

| Pfad | Was |
|---|---|
| `public/index.html` | Die Website (eine Datei, Bild und Schrift eingebettet) |
| `public/admin/index.html` | Admin-Bereich unter `/admin` |
| `public/fonts/` | Schrift Archivo für den Admin |
| `src/worker.js` | Backend: Datenbank, öffentliche Schnittstelle, Admin-Schnittstelle, Wochenmail |
| `wrangler.jsonc` | Cloudflare-Konfiguration (Datenbank, Login-Prüfung, Zeitplan) |
| `index.html` | Weiterleitung von der alten GitHub-Pages-Adresse auf backpackhero.at |

Läuft auf Cloudflare Workers (gratis) unter https://backpackhero.at, Admin unter https://backpackhero.at/admin. Jeder Push auf `main` geht automatisch live.

## Daten

Termine, Preise, Texte, Banner, Mail-Liste, Bestellungen und das Änderungsprotokoll liegen in der Cloudflare-Datenbank (D1), nicht in diesem Repository. Sie werden im Admin bearbeitet und sind sofort live. Eine Sicherung gibt es im Admin unter „Übersicht → Sicherung herunterladen“.

## Sicherheit

- `/admin` und `/api/admin/*` sind durch Cloudflare Access geschützt (Login mit Einmal-Code per Mail, nur freigegebene Adressen). Freigaben: Zero Trust → Access controls → Policies → „Backpack Hero Team“ (Selector **Emails**, nie „Email domain“).
- Der Worker prüft zusätzlich die Signatur des Access-Tokens selbst. Solange `ACCESS_TEAM_DOMAIN` und `ACCESS_AUD` nicht gesetzt sind, ist der Admin komplett gesperrt.
- Alle Texte aus der Datenbank werden nur als reiner Text angezeigt, nie als HTML.
- Formulare haben Spam-Schutz (verstecktes Feld und Begrenzung pro IP).
- In diesem Repository stehen keine Passwörter oder Schlüssel. Es ist öffentlich.

## Lokal testen

```
npm install
echo 'DEV_ADMIN_EMAIL="du@example.at"' > .dev.vars
npx wrangler dev
```

Dann `http://localhost:8787` und `http://localhost:8787/admin/` öffnen. Der Dev-Zugang zum Admin funktioniert nur unter `localhost` und wird nie veröffentlicht.
