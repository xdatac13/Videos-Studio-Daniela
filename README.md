# Estudio Daniela

L'éditeur vidéo de Daniela, devenu une application web autonome : comptes, projets sauvegardés, Claude côté serveur, déployable en un conteneur. L'interface est en espagnol (pour Daniela) ; ce document est en français (pour la personne qui héberge).

Deux outils dans la même application :

- **Crear un video** — le parcours guidé de l'artefact d'origine, fidèle au playbook : idée → script → voix off → prises → montage. La voix off fixe le rythme, les silences longs sont raccourcis sans effet robotique, les titres animés et les sous-titres sont incrustés, la musique baisse sous la voix.
- **Sacar extractos** — on dépose une vidéo longue (8 minutes ou plus) ; Claude la regarde en entier et en sort les meilleurs moments de 5 à 10 s (ou 10–20 s, 20–40 s), coupés sans tronquer une phrase, avec texte d'accroche, sous-titres et légende prête à publier.

Et partout : **Edita con Claude**, un chat où Daniela demande ses modifications avec ses mots (« fais l'accroche plus courte », « enlève la scène du papier », « qu'est-ce que tu améliorerais ? »). Claude modifie le projet ; chaque changement s'annule d'un clic.

## Démarrer en local

Il faut Node 22.13 ou plus récent.

```bash
npm install
```

```bash
npm run demo
```

`npm run demo` lance l'application sur http://localhost:3000 avec des réponses de démonstration : tous les écrans fonctionnent sans clé. Pour brancher le vrai Claude, copiez `.env.example` en `.env`, renseignez `ANTHROPIC_API_KEY`, puis :

```bash
npm start
```

Le premier compte créé devient administrateur (ou celui dont l'e-mail est dans `ADMIN_EMAIL`).

## Déployer

L'application est un seul conteneur ; la seule chose à conserver est le dossier `/data` (un fichier SQLite).

**Render** — `New → Blueprint`, choisir ce dépôt : `render.yaml` crée le service, le disque persistant et demande `ANTHROPIC_API_KEY`. Un disque persistant impose une instance payante.

**Un serveur avec Docker** (VPS, NAS…) :

```bash
docker compose up -d
```

**Railway, Fly.io et autres** — déployer le `Dockerfile`, monter un volume sur `/data`, définir `ANTHROPIC_API_KEY`.

Servez l'application en **HTTPS** : sans HTTPS, les navigateurs refusent le micro (l'enregistrement de la voix) hors de `localhost`.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `ANTHROPIC_API_KEY` | Clé Claude. Sans elle, le studio fonctionne mais sans les aides de Claude. |
| `CLAUDE_MODEL` | Modèle, `claude-opus-5-5` par défaut. `claude-sonnet-5-5` coûte moins cher. |
| `CLAUDE_EFFORT` | `low`, `medium` (défaut) ou `high`. |
| `AI_MOCK=1` | Réponses de démonstration, aucune clé nécessaire. |
| `ADMIN_EMAIL` | Le compte créé avec cet e-mail administre le studio. |
| `INVITE_CODE` | Si défini, créer un compte demande ce code. |
| `SIGNUP_MODE` | `open`, `invite` ou `closed`. |
| `PLAN_FREE_CREDITS`, `PLAN_PRO_CREDITS` | Crédits Claude par mois (40 et 600 par défaut). |
| `ELEVENLABS_API_KEY` | Optionnel. Transcription (Scribe) : sous-titres sur les extraits et coupes au mot près. |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `APP_URL` | Optionnel. Abonnement Stripe qui passe un compte en Pro. Webhook : `/api/billing/webhook`. |
| `PORT`, `DATA_DIR` | Port d'écoute et dossier de la base. |

## Comment ça marche

**Les vidéos ne quittent pas l'appareil.** Le navigateur fait tout le travail vidéo : décodage, analyse du son, rendu sur canvas, export. Les prises, la voix et la musique sont gardées dans le navigateur (IndexedDB) ; le serveur ne stocke que la structure du projet (du JSON). Conséquences : un serveur minuscule, aucun coût de stockage vidéo, et les rushes de Daniela restent chez elle. En contrepartie, un projet rouvert sur un autre appareil demande de redéposer ses prises.

**Ce que Claude reçoit.** Jamais la vidéo : des planches-contact (grilles d'images horodatées) et, si la transcription est activée, le texte avec le temps de chaque mot.

**La recherche d'extraits**, étape par étape :

1. le son est décodé sur l'appareil ; les silences et l'énergie sonore sont mesurés ;
2. si `ELEVENLABS_API_KEY` est défini, le son (mono 16 kHz) est transcrit avec le temps de chaque mot ;
3. une image toutes les 4 s environ part chez Claude avec la transcription : il choisit les moments ;
4. deuxième passe : une image par seconde autour de chaque moment, pour placer le début et la fin ;
5. chaque coupe est recalée sur la frontière de mot ou le silence le plus proche.

**Les crédits.** Chaque action Claude coûte des crédits (script, chat, textes de publication : 1 ; montage depuis les prises : 3 ; extraits : 4 + 2 d'affinage, + 2 de transcription). Chaque compte a un quota mensuel selon son plan ; l'écran d'administration montre les jetons réellement consommés par compte. Ordre de grandeur non mesuré, au tarif de `claude-opus-5-5` : quelques centimes pour un script, quelques dizaines de centimes pour les extraits d'une vidéo de 8 minutes.

## Administration

L'écran `Mi cuenta → Administrar el estudio` liste les comptes, leur consommation, et permet de changer leur plan. Il n'y a pas d'envoi d'e-mail : un mot de passe oublié se remet en ligne de commande.

```bash
npm run reset-password -- correo@ejemplo.com NouveauMotDePasse
```

```bash
npm run set-plan -- correo@ejemplo.com pro
```

```bash
npm run make-admin -- correo@ejemplo.com
```

## Limites connues

- **Export en temps réel** : créer un fichier prend la durée de la vidéo, onglet ouvert et visible.
- **Format du fichier** : le MP4 H.264 dépend du navigateur (Chrome et Safari récents). Sinon l'application le signale à l'écran.
- **Très gros fichiers** : au-delà d'environ 1,6 Go sur ordinateur (350 Mo sur téléphone), le son d'une vidéo longue n'est pas analysé ; les extraits sont alors choisis sur l'image seule.
- **Vidéos iPhone en HEVC** : certains navigateurs ne les lisent pas ; régler l'iPhone sur « Le plus compatible » ou convertir en MP4.
- **Stripe et ElevenLabs** sont écrits d'après leur API publique et couverts par des tests locaux (signature du webhook, format des requêtes), mais n'ont pas été exercés contre les services réels.

## Tests

```bash
npm test
```

Les tests démarrent l'API en mode démonstration (comptes, cloisonnement des projets, crédits, administration, signature Stripe) et vérifient la forme des requêtes envoyées à Claude contre un faux serveur local.

## Organisation du code

```
server/   app.js (API) · ai.js (prompts et appels Claude) · mock.js (démo) · auth.js · db.js · billing.js · cli.js
public/   index.html · css/app.css · fonts/ (polices auto-hébergées)
public/js main.js (session, routes, accueil, compte, admin)
          studio.js (parcours guidé) · chat.js (Edita con Claude) · clips.js (extraits)
          render.js (moteur : canvas, lecture, export) · audio.js · media.js · idb.js · api.js · util.js
```

Pas d'étape de build : le front est en modules JavaScript natifs, servis tels quels.
