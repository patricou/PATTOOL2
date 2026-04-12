/**
 * Textes d’aide du calendrier (FR / EN uniquement), affichés dans la modale « Aide ».
 * Regroupe l’ancien sous-titre, l’astuce activités, les jours fériés, la connexion, l’icône MongoDB et l’usage mobile.
 */
export const CALENDAR_HELP_TEXT_FR = `Agenda : vues semaine, jour, mois et liste. Vos rendez-vous et les activités auxquelles vous avez accès (miniatures). Glissez une plage horaire pour créer un rendez-vous ; en vue mois, un simple appui sur un jour ouvre aussi la fenêtre de création (pratique sur mobile).

Astuce : double-cliquez sur une activité pour ouvrir le mur de photos.

Jours fériés : choisissez le pays, puis basculez entre le nom dans la langue du pays ou dans la langue du programme (les libellés anglais de l’API sont traduits côté serveur PatTool avec mise en cache ; si la traduction échoue, le nom anglais s’affiche). Désactivation côté serveur : app.holiday-ui-translate.enabled=false.

Connexion : connectez-vous pour ajouter ou modifier vos rendez-vous personnels.

L’icône triangle rouge indique un rendez-vous personnel issu de la collection MongoDB calendar_appointments.

Survolez une entrée pour afficher une infobulle (titre, horaires, notes, ou détail des jours fériés).`;

export const CALENDAR_HELP_TEXT_EN = `Agenda: week, day, month, and list views. Your appointments and activities you can access (thumbnails). Drag a time range to create an appointment; in month view, tapping a day also opens the create dialog (especially useful on mobile).

Tip: double-click an activity to open the photo wall.

Public holidays: pick the country, then switch between the country language and the program language (English API names are translated on the PatTool server with caching; if translation fails, the English name is shown). Server toggle: app.holiday-ui-translate.enabled=false.

Sign in to add or edit your personal appointments.

The red warning icon marks a personal appointment from the MongoDB calendar_appointments collection.

Hover an entry to see a tooltip (title, times, notes, or public holiday details).`;
