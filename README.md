# Alerte tennis : Mourlon & Montherlant

Tu veux jouer à une date et une heure précises ? Ouvre un ticket ici. Le robot surveille **René et André Mourlon (15e)** et **Henry de Montherlant (16e)** et t'envoie **un mail** (plus une notif ntfy) dès qu'un court se libère. Il ne réserve rien à ta place.

## Faire une demande

1. Onglet **Issues** → **New issue** (sur iPhone : appli GitHub → ce dépôt → Issues → **+**).
2. Dans le titre, écris le jour et l'heure. Pas besoin de description :
   - `ven 23/10 17h`
   - `vendredi 17h-19h` (= créneaux de 17h et de 18h)
   - `demain 18h 19h`
3. **Create**.

En une minute, le robot répond « ✅ Bien reçu » dans le ticket. S'il n'a pas compris, il te le dit : modifie simplement le titre.

Ensuite, à chaque court qui se libère, il commente le ticket : tu reçois un mail avec le court, l'heure et le lien pour réserver.

## Arrêter une demande
- Tu as réservé : **ferme le ticket** (bouton *Close issue*).
- La date est passée : le robot le ferme tout seul.

## Bon à savoir
- Vérification toutes les 20 min, de 7h à 21h40 (heure d'été), et immédiatement quand tu ouvres un ticket.
- Paris Tennis ouvre les réservations 6 jours à l'avance, à 8h. Si tu demandes plus loin, le robot attend l'ouverture et te prévient dès que c'est réservable.
- Tu peux avoir plusieurs demandes ouvertes en même temps.
- Si le robot plante (mot de passe changé, site modifié…), il te prévient dans le ticket, une fois toutes les 6 h au maximum.
- Sur un dépôt public, GitHub met les tâches planifiées en pause après 60 jours sans modification du dépôt et t'envoie un mail. Il suffit de cliquer sur **Enable workflow** dans l'onglet Actions.

Le chargement du planning reprend le fonctionnement du projet open source [par-ici-tennis](https://github.com/bertrandda/par-ici-tennis) (licence MIT).
