# Daylight

Daylight is a calm, responsive daily planner for capturing tasks, organizing a week, and keeping reminders close. The UI uses native browser technologies; a small Python server persists planner data in SQLite. There are no package installs, user accounts, or paid AI API keys.

## Project

**Daylight — your personal AI-assisted daily planner**

- **Share the project:** [aniketsingh-netizen/taskflow-ai on GitHub](https://github.com/aniketsingh-netizen/taskflow-ai).
- **Create a live app:** once the latest changes are on `main`, click [Deploy Daylight to Render](https://render.com/deploy?repo=https://github.com/aniketsingh-netizen/taskflow-ai). Render reads `render.yaml` and sets up the Python web service and its persistent disk. Follow Render's prompts to connect GitHub and finish creating the service.
- **Your live share link:** Render gives you the public `*.onrender.com` address when the first deployment finishes; add that address here to share the running app.

The Render configuration includes a persistent SQLite disk, so tasks survive redeployments. Creating this service and its persistent disk can incur hosting charges; review Render's current pricing and deployment settings before confirming. For the production site, retain the configured disk, use HTTPS, and keep the service restricted to a single instance when using SQLite.

## Run locally

Start the app server from the repository folder:

```powershell
python server.py
```

Then open [http://localhost:8000](http://localhost:8000). The server creates `data/daylight.sqlite3` automatically. Set `PORT` to change the listening port, or set `DAYLIGHT_DATA_DIR` to choose where SQLite stores its database and journal files.

The app also works from a static file host, but that mode only saves data in the browser; use `python server.py` to enable the database.

## Use the planner

- Add tasks from the quick-capture box or **New task**. Edit, complete, and delete tasks from their task cards.
- Select your name in the header or sidebar profile to change it. Daylight uses it only in your greeting and profile initials, and changes its greeting between morning, afternoon, evening, and night based on your local time.
- On the first visit, enter your name to start your personal planner. Your name is used only in the greeting and your profile initials.
- Quick capture understands common dates (today, tomorrow, and weekdays), times, durations, priority words, and category hashtags. For example: `Send the project update tomorrow at 10am for 30 minutes #work`.
- Switch between day and week views, choose dates from the calendar, or filter by category, upcoming tasks, and completed tasks.
- Choose **Plan my day** for locally generated priority and time suggestions. Apply a suggestion to add its time to a task. This lightweight planner uses your task details and does not send data to an AI service.
- Choose Fern, Ocean, Lavender, or Sunset from the theme selector. Your selection is saved with your planner data.
- Download an individual task's `.ics` file from its task card, or export the current view as one calendar file. Open the file with a calendar app to import the event(s).
- Choose a reminder and a scheduled time while creating or editing a task. Browser notification permission is requested only when you choose the bell button.

## Data and reminders

With the Python server, tasks, reminders, name, and theme are synchronized to a SQLite database and cached in the browser. Each browser profile gets its own random planner identity; no email or password is collected. The random identity acts like an unlisted access key to that planner: it is stored in the browser, so protect access to your device and deploy Daylight behind HTTPS. Anyone who obtains that key can access that planner. The same browser profile restores its data on later visits, including after app deployments, provided the SQLite database remains on persistent storage. Clearing that browser's site data loses the identity key, so the existing profile cannot be recovered. This lightweight app does not provide account recovery or cross-device sign-in.

**Deployment persistence matters:** SQLite stores data in `DAYLIGHT_DATA_DIR` (by default, the repository's `data` directory). For a hosting provider that replaces or resets its filesystem on deployment, attach a persistent disk/volume and set `DAYLIGHT_DATA_DIR` to a directory on that volume. A normal ephemeral container filesystem cannot preserve a database across redeploys. The server serves both the app and its `/api` endpoints, so deploy it as a Python web service rather than as static files only.

Calendar exports are created in your browser and are not uploaded.

Reminders are checked while the Daylight page is open. If browser notifications are supported and allowed, a reminder can appear as a notification when the page is in the background. Browsers do not guarantee scheduled alarms after the page or browser is closed, so Daylight does not claim that closed-page reminders will fire. In-app reminders remain available without notification permission.

Requires Python 3.10 or later. The interface uses native HTML, CSS, and JavaScript, and the server uses Python's standard library. No build or package installation is required.

Run the server/database integration checks with:

```powershell
python -m unittest discover -s tests -v
```
