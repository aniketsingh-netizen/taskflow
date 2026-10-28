"use strict";

(() => {
  const STORAGE_KEY = "daylight.tasks.v1";
  const REMINDER_STATE_KEY = "daylight.reminders.v1";
  const USER_ID_KEY = "daylight.user.v1";
  const THEME_KEY = "daylight.theme.v1";
  const PENDING_SYNC_KEY = "daylight.pending-sync.v1";
  const themes = new Set(["fern", "ocean", "lavender", "sunset"]);
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const state = {
    tasks: loadTasks(),
    selectedDate: toDateKey(new Date()),
    currentMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    userId: loadUserId(),
    theme: loadTheme(),
    syncQueue: Promise.resolve(),
    view: "day",
    category: null,
    sortByPriority: true,
    plan: [],
    reminderState: loadReminderState(),
    toastTimer: null
  };
  const el = (id) => document.getElementById(id);
  const dialog = el("task-dialog");

  function toDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function fromDateKey(key) {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function shiftDate(key, amount) {
    const date = fromDateKey(key);
    date.setDate(date.getDate() + amount);
    return toDateKey(date);
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function createUserId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") return null;
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function loadTasks() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved.filter((task) => task && typeof task.id === "string" && typeof task.title === "string" && /^\d{4}-\d{2}-\d{2}$/.test(task.date));
    } catch (error) {
      console.error("Could not read saved planner tasks.", error);
      return [];
    }
  }

  function loadReminderState() {
    try {
      const saved = JSON.parse(localStorage.getItem(REMINDER_STATE_KEY) || "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch (error) {
      console.error("Could not read saved reminder state.", error);
      return {};
    }
  }

  function loadUserId() {
    try {
      const saved = localStorage.getItem(USER_ID_KEY);
      if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)) return saved;
      const userId = createUserId();
      if (!userId) return null;
      localStorage.setItem(USER_ID_KEY, userId);
      return userId;
    } catch (error) {
      console.error("Could not load a persistent planner identity.", error);
      return null;
    }
  }

  function loadTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return themes.has(saved) ? saved : "fern";
    } catch (error) {
      console.error("Could not load the saved color theme.", error);
      return "fern";
    }
  }

  function currentDocument() {
    return { tasks: state.tasks, reminderState: state.reminderState, theme: state.theme };
  }

  function saveLocalDocument(pendingSync) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
      localStorage.setItem(REMINDER_STATE_KEY, JSON.stringify(state.reminderState));
      localStorage.setItem(THEME_KEY, state.theme);
      if (pendingSync !== null) localStorage.setItem(PENDING_SYNC_KEY, pendingSync ? "1" : "0");
      return true;
    } catch (error) {
      console.error("Could not save planner data in this browser.", error);
      return false;
    }
  }

  function setStorageStatus(message, status) {
    const indicator = el("storage-status");
    indicator.textContent = message;
    indicator.dataset.status = status;
    indicator.title = status === "saved"
      ? "Your planner data is saved in the SQLite database."
      : status === "syncing"
        ? "Saving your latest changes to the SQLite database."
        : "Planner data is currently saved in this browser only.";
  }

  function syncToDatabase(snapshot) {
    setStorageStatus("Saving to database…", "syncing");
    return fetch("/api/tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-User-ID": state.userId },
      body: snapshot
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Planner database returned HTTP ${response.status}.`);
      const latest = JSON.stringify(currentDocument());
      if (latest === snapshot) {
        try {
          localStorage.setItem(PENDING_SYNC_KEY, "0");
        } catch (error) {
          console.error("Could not update local sync status.", error);
        }
        setStorageStatus("Saved to database", "saved");
      } else {
        setStorageStatus("Saving to database…", "syncing");
      }
    }).catch((error) => {
      console.error("Could not sync planner data with the database.", error);
      setStorageStatus("Saved on this device", "local");
    });
  }

  function queueDatabaseSync() {
    if (!state.userId) {
      setStorageStatus("Saved on this device", "local");
      return Promise.resolve();
    }
    const snapshot = JSON.stringify(currentDocument());
    state.syncQueue = state.syncQueue.then(() => syncToDatabase(snapshot), () => syncToDatabase(snapshot));
    return state.syncQueue;
  }

  function applyTheme(theme) {
    const selected = themes.has(theme) ? theme : "fern";
    document.documentElement.dataset.theme = selected;
    el("theme-select").value = selected;
  }

  function changeTheme(theme) {
    if (!themes.has(theme) || theme === state.theme) return;
    const previousTheme = state.theme;
    state.theme = theme;
    applyTheme(theme);
    if (!save()) {
      state.theme = previousTheme;
      applyTheme(previousTheme);
      return;
    }
    showToast(`${theme.charAt(0).toUpperCase()}${theme.slice(1)} theme applied.`);
  }

  function save() {
    const localSaved = saveLocalDocument(true);
    if (!localSaved) {
      showToast("Your browser couldn't save this change. Check available device storage.");
      return false;
    }
    queueDatabaseSync();
    return true;
  }

  async function initializeDatabase() {
    if (!state.userId) {
      setStorageStatus("Saved on this device", "local");
      render();
      return;
    }
    setStorageStatus("Connecting to database…", "syncing");
    try {
      const response = await fetch("/api/tasks", { headers: { "X-User-ID": state.userId } });
      if (!response.ok) throw new Error(`Planner database returned HTTP ${response.status}.`);
      const remote = await response.json();
      const hasPendingChanges = localStorage.getItem(PENDING_SYNC_KEY) === "1";
      if (hasPendingChanges) {
        await queueDatabaseSync();
      } else if (remote.exists) {
        state.tasks = remote.tasks;
        state.reminderState = remote.reminderState;
        state.theme = themes.has(remote.theme) ? remote.theme : "fern";
        saveLocalDocument(false);
        applyTheme(state.theme);
        setStorageStatus("Saved to database", "saved");
      } else if (state.tasks.length || Object.keys(state.reminderState).length || state.theme !== "fern") {
        await queueDatabaseSync();
      } else {
        setStorageStatus("Database connected", "saved");
      }
    } catch (error) {
      console.error("Could not load planner data from the database.", error);
      setStorageStatus("Saved on this device", "local");
    }
    render();
  }

  function formatDate(key, options = { weekday: "long", month: "long", day: "numeric" }) {
    return new Intl.DateTimeFormat(undefined, options).format(fromDateKey(key));
  }

  function formatTime(value) {
    if (!value) return "Any time";
    const [hours, minutes] = value.split(":").map(Number);
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, hours, minutes));
  }

  function formatReminderTime(task) {
    if (task.reminder === null || task.reminder === undefined || !task.time) return "";
    const [hours, minutes] = task.time.split(":").map(Number);
    const when = new Date(fromDateKey(task.date));
    when.setHours(hours, minutes - Number(task.reminder), 0, 0);
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(when);
  }

  function categoryClass(category) {
    return ({ Work: "tag-work", Personal: "tag-personal", Wellbeing: "tag-wellbeing" })[category] || "";
  }

  function showToast(message) {
    const region = el("toast-region");
    region.replaceChildren();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    region.append(toast);
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => region.replaceChildren(), 3600);
  }

  function titleForView() {
    if (state.category) return `${state.category} tasks`;
    if (state.view === "completed") return "Completed tasks";
    if (state.view === "upcoming") return "Coming up";
    if (state.view === "week") return "Your week";
    if (state.selectedDate === toDateKey(new Date())) return "Good morning, Aniket";
    return formatDate(state.selectedDate, { weekday: "long" });
  }

  function getVisibleTasks() {
    let tasks = state.tasks;
    if (state.category) tasks = tasks.filter((task) => task.category === state.category && !task.completed);
    else if (state.view === "completed") tasks = tasks.filter((task) => task.completed);
    else if (state.view === "upcoming") tasks = tasks.filter((task) => !task.completed && task.date > toDateKey(new Date()));
    else tasks = tasks.filter((task) => !task.completed && task.date === state.selectedDate);

    return [...tasks].sort((a, b) => {
      const byTime = (a.time || "99:99").localeCompare(b.time || "99:99");
      if (state.sortByPriority && a.priority !== b.priority) return priorityRank[a.priority] - priorityRank[b.priority];
      return byTime || (priorityRank[a.priority] - priorityRank[b.priority]) || a.title.localeCompare(b.title);
    });
  }

  function updateHeader() {
    const isToday = state.selectedDate === toDateKey(new Date());
    const label = state.category || ({ day: isToday ? "My day" : formatDate(state.selectedDate, { month: "short", day: "numeric" }), week: "Week", upcoming: "Upcoming", completed: "Completed" })[state.view];
    el("topbar-view-label").textContent = label;
    el("topbar-date").textContent = formatDate(toDateKey(new Date()), { weekday: "short", month: "short", day: "numeric" });
    el("page-title").textContent = titleForView();
    el("heading-eyebrow").textContent = state.category ? "A LITTLE SPACE FOR WHAT MATTERS" : state.view === "week" ? "THE DAYS AHEAD, AT A GLANCE" : state.view === "completed" ? "LOOK HOW FAR YOU’VE COME" : state.view === "upcoming" ? "GOOD THINGS ON THE HORIZON" : "YOUR DAY, AT A GLANCE";
    el("page-subtitle").textContent = state.category ? `A little room for your ${state.category.toLowerCase()} priorities.` : state.view === "completed" ? "All the things you’ve already taken care of." : state.view === "upcoming" ? "Your next steps, ready when you are." : state.view === "week" ? "A gentle look at the next seven days." : isToday ? "A fresh page, and plenty of room to make it yours." : "One day at a time. Make this one count.";
    el("task-section-title").textContent = state.category ? `${state.category} tasks` : state.view === "completed" ? "Done and dusted" : state.view === "upcoming" ? "Coming up next" : state.view === "week" ? "This week" : state.selectedDate === toDateKey(new Date()) ? "Today’s tasks" : formatDate(state.selectedDate, { month: "long", day: "numeric" });
    document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("is-active", !state.category && button.dataset.view === state.view));
    document.querySelectorAll(".space-link").forEach((button) => button.classList.toggle("is-active", button.dataset.category === state.category));
    document.querySelectorAll(".view-option").forEach((button) => button.classList.toggle("is-selected", button.dataset.display === (state.view === "week" ? "week" : "day")));
  }

  function renderMiniCalendar() {
    const year = state.currentMonth.getFullYear();
    const month = state.currentMonth.getMonth();
    el("mini-month-label").textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(state.currentMonth);
    const first = new Date(year, month, 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - mondayOffset);
    const taskDates = new Set(state.tasks.map((task) => task.date));
    const grid = el("mini-calendar-grid");
    grid.replaceChildren();
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = toDateKey(date);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mini-day";
      button.textContent = String(date.getDate());
      button.setAttribute("aria-label", formatDate(key));
      if (date.getMonth() !== month) button.classList.add("is-outside");
      if (key === toDateKey(new Date())) button.classList.add("is-today");
      if (key === state.selectedDate) button.classList.add("is-selected");
      if (taskDates.has(key)) button.classList.add("has-tasks");
      button.addEventListener("click", () => {
        state.selectedDate = key;
        state.view = "day";
        state.category = null;
        render();
      });
      grid.append(button);
    }
  }

  function renderTasks() {
    const tasks = getVisibleTasks();
    let taskCount = tasks.length;
    if (state.view === "week" && !state.category) {
      const monday = fromDateKey(state.selectedDate);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const mondayKey = toDateKey(monday);
      const sundayKey = shiftDate(mondayKey, 6);
      taskCount = state.tasks.filter((task) => !task.completed && task.date >= mondayKey && task.date <= sundayKey).length;
    }
    el("task-section-count").textContent = taskCount ? `${taskCount} ${taskCount === 1 ? "task" : "tasks"}` : "";
    el("today-count").textContent = String(state.tasks.filter((task) => !task.completed && task.date === toDateKey(new Date())).length);
    el("task-list").hidden = state.view === "week" && !state.category;
    el("week-view").hidden = state.view !== "week" || Boolean(state.category);
    el("task-list").replaceChildren();
    if (state.view === "week" && !state.category) {
      renderWeek();
      return;
    }
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const illustration = document.createElement("span");
      illustration.className = "empty-illustration";
      illustration.textContent = state.view === "completed" ? "✓" : "✦";
      const title = document.createElement("strong");
      title.textContent = state.view === "completed" ? "Nothing checked off just yet" : state.view === "upcoming" ? "Nothing on the horizon" : "A little breathing room";
      const description = document.createElement("p");
      description.textContent = state.view === "completed" ? "Finish a task and it’ll find its way here." : "Add a task above, or let your mind wander for a moment.";
      empty.append(illustration, title, description);
      el("task-list").append(empty);
      return;
    }
    tasks.forEach((task) => el("task-list").append(createTaskCard(task)));
  }

  function createTaskCard(task) {
    const card = document.createElement("article");
    card.className = `task-card${task.completed ? " is-completed" : ""}`;
    const check = document.createElement("button");
    check.className = "task-check";
    check.type = "button";
    check.setAttribute("aria-label", task.completed ? `Mark ${task.title} as not done` : `Complete ${task.title}`);
    check.innerHTML = task.completed ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5"/></svg>' : "";
    check.addEventListener("click", () => toggleTask(task.id));
    const main = document.createElement("div");
    main.className = "task-main";
    const title = document.createElement("p");
    title.className = "task-title";
    title.textContent = task.title;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    if (task.time) {
      const time = document.createElement("span");
      time.className = "task-meta-item";
      time.innerHTML = '<span class="task-meta-icon" aria-hidden="true">◷</span>';
      time.append(document.createTextNode(formatTime(task.time)));
      meta.append(time, Object.assign(document.createElement("span"), { className: "meta-divider" }));
    }
    const category = document.createElement("span");
    category.className = `task-tag ${categoryClass(task.category)}`;
    category.textContent = task.category || "Other";
    meta.append(category);
    const priority = document.createElement("span");
    priority.className = `priority-mark priority-${task.priority || "medium"}`;
    priority.textContent = `${(task.priority || "medium").charAt(0).toUpperCase()}${(task.priority || "medium").slice(1)} priority`;
    meta.append(priority);
    if (task.reminder !== null && task.reminder !== undefined) {
      const reminder = document.createElement("span");
      reminder.className = "task-meta-item";
      reminder.innerHTML = '<span class="task-meta-icon" aria-hidden="true">♧</span>';
      reminder.append(document.createTextNode(task.time ? formatReminderTime(task) : "Reminder"));
      meta.append(reminder);
    }
    main.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "task-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "✎";
    edit.setAttribute("aria-label", `Edit ${task.title}`);
    edit.addEventListener("click", () => openTaskDialog(task));
    const calendar = document.createElement("button");
    calendar.type = "button";
    calendar.textContent = "↗";
    calendar.setAttribute("aria-label", `Add ${task.title} to a calendar`);
    calendar.title = "Download calendar event";
    calendar.addEventListener("click", () => downloadCalendarEvent(task));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${task.title}`);
    remove.addEventListener("click", () => deleteTask(task.id));
    actions.append(edit, calendar, remove);
    card.append(check, main, actions);
    return card;
  }

  function renderWeek() {
    const grid = el("week-view");
    grid.replaceChildren();
    const selected = fromDateKey(state.selectedDate);
    const mondayOffset = (selected.getDay() + 6) % 7;
    const monday = new Date(selected);
    monday.setDate(selected.getDate() - mondayOffset);
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + index);
      const key = toDateKey(date);
      const column = document.createElement("button");
      column.type = "button";
      column.className = `week-day${key === state.selectedDate ? " is-selected" : ""}${key === toDateKey(new Date()) ? " is-today" : ""}`;
      const header = document.createElement("div");
      header.className = "week-day-header";
      const weekday = document.createElement("span");
      weekday.textContent = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
      const dayNumber = document.createElement("strong");
      dayNumber.textContent = String(date.getDate());
      header.append(weekday, dayNumber);
      column.append(header);
      state.tasks.filter((task) => task.date === key).sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99")).forEach((task) => {
        const chip = document.createElement("div");
        chip.className = `week-task${task.completed ? " is-done" : ""}`;
        chip.textContent = `${task.time ? `${formatTime(task.time)} · ` : ""}${task.title}`;
        column.append(chip);
      });
      column.addEventListener("click", () => {
        state.selectedDate = key;
        state.category = null;
        render();
      });
      grid.append(column);
    }
  }

  function renderProgress() {
    const dayTasks = state.tasks.filter((task) => task.date === state.selectedDate);
    const done = dayTasks.filter((task) => task.completed).length;
    const percent = dayTasks.length ? Math.round((done / dayTasks.length) * 100) : 0;
    el("progress-ring").style.setProperty("--progress", `${percent}%`);
    el("progress-value").textContent = `${percent}%`;
    el("progress-label").textContent = !dayTasks.length ? "A fresh start" : percent === 100 ? "Nicely done" : percent >= 60 ? "Finding your flow" : "One step at a time";
    el("progress-detail").textContent = `${done} of ${dayTasks.length} ${dayTasks.length === 1 ? "task" : "tasks"} done`;
  }

  function renderReminders() {
    const reminders = state.tasks.filter((task) => !task.completed && task.date === state.selectedDate && task.time && task.reminder !== null && task.reminder !== undefined).sort((a, b) => a.time.localeCompare(b.time));
    el("reminder-count").textContent = String(reminders.length);
    const list = el("reminder-list");
    list.replaceChildren();
    if (!reminders.length) {
      const empty = document.createElement("p");
      empty.className = "reminders-empty";
      empty.textContent = "Add a time and reminder to any task and it’ll appear here.";
      list.append(empty);
      return;
    }
    reminders.slice(0, 4).forEach((task) => {
      const item = document.createElement("div");
      item.className = "reminder-item";
      const clock = document.createElement("span");
      clock.className = "reminder-clock";
      clock.textContent = "◷";
      const name = document.createElement("span");
      name.className = "reminder-task";
      name.textContent = task.title;
      name.title = task.title;
      const time = document.createElement("span");
      time.className = "reminder-time";
      time.textContent = formatReminderTime(task);
      item.append(clock, name, time);
      list.append(item);
    });
  }

  function render() {
    updateHeader();
    renderMiniCalendar();
    renderTasks();
    renderProgress();
    renderReminders();
    renderPlan();
    updateNotificationIndicator();
  }

  function openTaskDialog(task = null, defaults = {}) {
    el("task-form").reset();
    el("dialog-title").textContent = task ? "Edit your task" : "A new task";
    el("save-task-button").textContent = task ? "Save changes" : "Save task";
    el("task-title").value = task ? task.title : defaults.title || "";
    el("task-date").value = task ? task.date : defaults.date || state.selectedDate;
    el("task-time").value = task ? task.time || "" : defaults.time || "";
    el("task-category").value = task ? task.category || "Work" : defaults.category || "Work";
    el("task-priority").value = task ? task.priority || "medium" : defaults.priority || "medium";
    el("task-duration").value = String(task ? task.duration || 30 : defaults.duration || 30);
    el("task-reminder").value = task && task.reminder !== null && task.reminder !== undefined ? String(task.reminder) : defaults.reminder !== undefined && defaults.reminder !== null ? String(defaults.reminder) : "";
    dialog.dataset.editingId = task ? task.id : "";
    dialog.showModal();
    el("task-title").focus();
  }

  function saveTask(event) {
    event.preventDefault();
    const formData = new FormData(el("task-form"));
    const title = String(formData.get("title") || "").trim();
    if (!title) return;
    const time = String(formData.get("time") || "");
    const reminderValue = formData.get("reminder");
    if (reminderValue !== "" && !time) {
      showToast("Add a time to this task before setting a reminder.");
      el("task-time").focus();
      return;
    }
    const editId = dialog.dataset.editingId;
    const existing = state.tasks.find((task) => task.id === editId);
    const previousTasks = state.tasks;
    const previousReminderState = state.reminderState;
    const previousPlan = state.plan;
    const task = {
      id: existing ? existing.id : createId(),
      title,
      date: String(formData.get("date")),
      time,
      category: String(formData.get("category") || "Work"),
      priority: String(formData.get("priority") || "medium"),
      duration: Number(formData.get("duration") || 30),
      reminder: reminderValue === "" ? null : Number(reminderValue),
      completed: existing ? existing.completed : false,
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    };
    if (existing) state.tasks = state.tasks.map((item) => item.id === existing.id ? task : item);
    else state.tasks = [...state.tasks, task];
    state.reminderState = { ...state.reminderState };
    delete state.reminderState[task.id];
    state.plan = [];
    if (!save()) {
      state.tasks = previousTasks;
      state.reminderState = previousReminderState;
      state.plan = previousPlan;
      return;
    }
    state.selectedDate = task.date;
    state.currentMonth = new Date(fromDateKey(task.date).getFullYear(), fromDateKey(task.date).getMonth(), 1);
    state.view = "day";
    state.category = null;
    dialog.close();
    render();
    showToast(existing ? "Your changes are saved." : "Task added to your day.");
  }

  function toggleTask(id) {
    const previousTasks = state.tasks;
    state.tasks = state.tasks.map((task) => task.id === id ? { ...task, completed: !task.completed } : task);
    if (!save()) {
      state.tasks = previousTasks;
      return;
    }
    render();
  }

  function deleteTask(id) {
    const previousTasks = state.tasks;
    const previousReminderState = state.reminderState;
    const previousPlan = state.plan;
    state.tasks = state.tasks.filter((task) => task.id !== id);
    state.reminderState = { ...state.reminderState };
    delete state.reminderState[id];
    state.plan = state.plan.filter((item) => item.id !== id);
    if (!save()) {
      state.tasks = previousTasks;
      state.reminderState = previousReminderState;
      state.plan = previousPlan;
      return;
    }
    render();
    showToast("Task removed.");
  }

  function dateFromWeekday(name, startKey) {
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const target = weekdays.indexOf(name.toLowerCase());
    if (target < 0) return null;
    const start = fromDateKey(startKey);
    let delta = (target - start.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return toDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta, 12));
  }

  function parseNaturalTask(input) {
    let title = input.trim();
    const parsed = { date: state.selectedDate, time: "", priority: "medium", category: "Work", duration: 30, reminder: null };
    const todayKey = toDateKey(new Date());
    const tomorrowKey = shiftDate(todayKey, 1);
    const dateMatchers = [
      [/\bday after tomorrow\b/i, shiftDate(todayKey, 2)],
      [/\btomorrow\b/i, tomorrowKey],
      [/\btoday\b/i, todayKey]
    ];
    for (const [pattern, date] of dateMatchers) {
      if (pattern.test(title)) {
        parsed.date = date;
        title = title.replace(pattern, " ");
        break;
      }
    }
    if (parsed.date === state.selectedDate && !/\b(today|tomorrow|day after tomorrow)\b/i.test(input)) {
      const weekdayMatch = title.match(/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      if (weekdayMatch) {
        parsed.date = dateFromWeekday(weekdayMatch[1], todayKey);
        title = title.replace(weekdayMatch[0], " ");
      }
    }
    const timeMatch = title.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i)
      || title.match(/\b(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?)\b/i);
    if (timeMatch) {
      let hours = Number(timeMatch[1]);
      const minutes = Number(timeMatch[2] || 0);
      const meridiem = (timeMatch[3] || "").toLowerCase().replace(/\./g, "");
      if (minutes < 60 && hours <= 12) {
        if (meridiem === "pm" && hours < 12) hours += 12;
        if (meridiem === "am" && hours === 12) hours = 0;
        if (!meridiem && hours < 8) hours += 12;
        parsed.time = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
        parsed.reminder = 10;
        title = title.replace(timeMatch[0], " ");
      }
    }
    const durationMatch = title.match(/\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b/i);
    if (durationMatch) {
      const amount = Number(durationMatch[1]);
      const minutes = /h|hour/i.test(durationMatch[2]) ? amount * 60 : amount;
      parsed.duration = Math.max(15, Math.min(120, Math.round(minutes / 15) * 15));
      title = title.replace(durationMatch[0], " ");
    }
    const tagMatch = title.match(/#(work|personal|wellbeing|health|other)\b/i);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      parsed.category = tag === "health" ? "Wellbeing" : tag.charAt(0).toUpperCase() + tag.slice(1);
      title = title.replace(tagMatch[0], " ");
    } else if (/\b(work|meeting|client|project|report|email|presentation)\b/i.test(title)) parsed.category = "Work";
    else if (/\b(gym|walk|meditate|doctor|exercise|yoga|health)\b/i.test(title)) parsed.category = "Wellbeing";
    else parsed.category = "Personal";
    if (/\b(urgent|asap|critical|high priority)\b/i.test(title)) parsed.priority = "high";
    else if (/\b(low priority|when i can|if time)\b/i.test(title)) parsed.priority = "low";
    title = title.replace(/\b(urgent|asap|critical|high priority|low priority|when i can|if time)\b/gi, " ");
    title = title.replace(/\s+/g, " ").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "");
    return { ...parsed, title };
  }

  function captureTask(event) {
    event.preventDefault();
    const input = el("capture-input");
    const raw = input.value.trim();
    if (!raw) return;
    const parsed = parseNaturalTask(raw);
    if (!parsed.title) {
      el("capture-feedback").textContent = "Add a few words to describe your task.";
      el("capture-feedback").classList.add("is-notice");
      return;
    }
    const previousTasks = state.tasks;
    state.tasks = [...state.tasks, { ...parsed, id: createId(), completed: false, createdAt: new Date().toISOString() }];
    if (!save()) {
      state.tasks = previousTasks;
      return;
    }
    state.selectedDate = parsed.date;
    state.currentMonth = new Date(fromDateKey(parsed.date).getFullYear(), fromDateKey(parsed.date).getMonth(), 1);
    state.view = "day";
    state.category = null;
    state.plan = [];
    input.value = "";
    const parsedDetails = [formatDate(parsed.date, { month: "short", day: "numeric" }), parsed.time ? formatTime(parsed.time) : "", parsed.category].filter(Boolean).join(" · ");
    el("capture-feedback").textContent = `Added “${parsed.title}” · ${parsedDetails}`;
    el("capture-feedback").classList.add("is-notice");
    render();
    showToast("Task added. You’re all set.");
  }

  function startTimeForPlan(dateKey) {
    const now = new Date();
    const today = toDateKey(now) === dateKey;
    let minutes = today ? Math.max(8 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30) : 9 * 60;
    return Math.min(minutes, 19 * 60);
  }

  function planMyDay() {
    const incomplete = state.tasks.filter((task) => task.date === state.selectedDate && !task.completed);
    if (!incomplete.length) {
      el("plan-summary").textContent = "Add a task for this day and I’ll help you find a good rhythm.";
      el("plan-list").replaceChildren();
      return;
    }
    const ordered = [...incomplete].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]
      || (a.time || "99:99").localeCompare(b.time || "99:99")
      || a.createdAt.localeCompare(b.createdAt));
    let cursor = startTimeForPlan(state.selectedDate);
    state.plan = ordered.slice(0, 5).map((task) => {
      const proposed = task.time ? Math.max(cursor, Number(task.time.slice(0, 2)) * 60 + Number(task.time.slice(3))) : cursor;
      const rounded = Math.ceil(proposed / 15) * 15;
      const slot = Math.min(rounded, 19 * 60);
      cursor = slot + Number(task.duration || 30) + 10;
      return { id: task.id, time: `${String(Math.floor(slot / 60)).padStart(2, "0")}:${String(slot % 60).padStart(2, "0")}` };
    });
    const highPriority = incomplete.filter((task) => task.priority === "high").length;
    el("plan-summary").textContent = highPriority ? `Let’s give your ${highPriority === 1 ? "top priority" : `${highPriority} top priorities`} a little breathing room.` : "A steady pace beats a packed calendar. Here’s one way through.";
    renderPlan();
  }

  function renderPlan() {
    const list = el("plan-list");
    list.replaceChildren();
    state.plan.forEach((suggestion) => {
      const task = state.tasks.find((item) => item.id === suggestion.id);
      if (!task || task.completed) return;
      const row = document.createElement("div");
      row.className = "plan-suggestion";
      const time = document.createElement("span");
      time.className = "suggestion-time";
      time.textContent = formatTime(suggestion.time);
      const title = document.createElement("span");
      title.className = "suggestion-task";
      title.textContent = task.title;
      title.title = task.title;
      const apply = document.createElement("button");
      apply.className = "suggestion-apply";
      apply.type = "button";
      apply.textContent = task.time === suggestion.time ? "Set" : "Apply";
      apply.disabled = task.time === suggestion.time;
      apply.addEventListener("click", () => {
        const previousTasks = state.tasks;
        state.tasks = state.tasks.map((item) => item.id === task.id ? { ...item, time: suggestion.time } : item);
        if (!save()) {
          state.tasks = previousTasks;
          return;
        }
        render();
        renderPlan();
        showToast(`Suggested time added to “${task.title}”.`);
      });
      row.append(time, title, apply);
      list.append(row);
    });
  }

  function escapeCalendarText(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }

  function calendarEventText(task) {
    const start = fromDateKey(task.date);
    let end;
    let dateLines;
    if (task.time) {
      const [hours, minutes] = task.time.split(":").map(Number);
      start.setHours(hours, minutes, 0, 0);
      end = new Date(start.getTime() + Number(task.duration || 30) * 60_000);
      const toCalendarDate = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}00`;
      dateLines = `DTSTART:${toCalendarDate(start)}\r\nDTEND:${toCalendarDate(end)}`;
    } else {
      const nextDay = shiftDate(task.date, 1).replace(/-/g, "");
      const day = task.date.replace(/-/g, "");
      dateLines = `DTSTART;VALUE=DATE:${day}\r\nDTEND;VALUE=DATE:${nextDay}`;
    }
    return [
      "BEGIN:VEVENT",
      `UID:${escapeCalendarText(task.id)}@daylight.local`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
      dateLines,
      `SUMMARY:${escapeCalendarText(task.title)}`,
      `DESCRIPTION:${escapeCalendarText(`${task.category || "Other"} · ${task.priority || "medium"} priority`)}`,
      `CATEGORIES:${escapeCalendarText(task.category || "Other")}`,
      "END:VEVENT",
    ].join("\r\n");
  }

  function downloadCalendarTasks(tasks, filename) {
    const calendarText = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Daylight Planner//EN",
      "CALSCALE:GREGORIAN",
      ...tasks.map(calendarEventText),
      "END:VCALENDAR",
      ""
    ].join("\r\n");
    const blob = new Blob([calendarText], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCalendarEvent(task) {
    const filename = `${task.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().slice(0, 70) || "daylight-task"}.ics`;
    downloadCalendarTasks([task], filename);
    showToast("Calendar file downloaded. Open it to add the task to your calendar.");
  }

  function getCalendarExportTasks() {
    if (state.category) return state.tasks.filter((task) => task.category === state.category && !task.completed);
    if (state.view === "completed") return state.tasks.filter((task) => task.completed);
    if (state.view === "upcoming") return state.tasks.filter((task) => !task.completed && task.date > toDateKey(new Date()));
    if (state.view === "week") {
      const monday = fromDateKey(state.selectedDate);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const mondayKey = toDateKey(monday);
      const sundayKey = shiftDate(mondayKey, 6);
      return state.tasks.filter((task) => task.date >= mondayKey && task.date <= sundayKey);
    }
    return state.tasks.filter((task) => task.date === state.selectedDate);
  }

  function updateNotificationIndicator() {
    const supported = "Notification" in window;
    const enabled = supported && Notification.permission === "granted";
    el("notification-indicator").classList.toggle("is-enabled", enabled);
    el("notification-button").title = enabled ? "Browser notifications enabled" : "Enable browser notifications";
    el("notification-button").setAttribute("aria-label", enabled ? "Browser notifications enabled" : "Enable browser notifications");
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      showToast("This browser doesn’t support notifications. In-app reminders still work while Daylight is open.");
      return;
    }
    if (Notification.permission === "granted") {
      showToast("Browser notifications are already enabled.");
      return;
    }
    if (Notification.permission === "denied") {
      showToast("Notifications are blocked by your browser. You can change this in site settings.");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      updateNotificationIndicator();
      showToast(permission === "granted" ? "Notifications enabled for reminders while Daylight is open." : "No problem — in-app reminders will still appear while Daylight is open.");
    } catch (error) {
      console.error("Could not request notification permission.", error);
      showToast("Your browser couldn’t enable notifications. In-app reminders still work while Daylight is open.");
    }
  }

  function checkReminders() {
    const now = new Date();
    state.tasks.forEach((task) => {
      if (task.completed || !task.time || task.reminder === null || task.reminder === undefined) return;
      const [hours, minutes] = task.time.split(":").map(Number);
      const reminderAt = fromDateKey(task.date);
      reminderAt.setHours(hours, minutes - Number(task.reminder), 0, 0);
      const dueDiff = now.getTime() - reminderAt.getTime();
      const scheduledAt = fromDateKey(task.date);
      scheduledAt.setHours(hours, minutes, 0, 0);
      if (dueDiff < 0 || now.getTime() > scheduledAt.getTime() + 5 * 60_000 || state.reminderState[task.id] === `${task.date}T${task.time}`) return;
      state.reminderState[task.id] = `${task.date}T${task.time}`;
      save();
      const message = task.reminder === 0 ? `It’s time for ${task.title}.` : `${task.title} starts in ${task.reminder} minutes.`;
      if (document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") showToast(message);
      else {
        try {
          new Notification("Daylight reminder", { body: message, tag: `daylight-${task.id}` });
        } catch (error) {
          console.error("Could not display a browser reminder.", error);
          showToast(message);
        }
      }
    });
  }

  function handleViewClick(view) {
    state.view = view;
    state.category = null;
    if (view === "week") state.selectedDate = state.selectedDate || toDateKey(new Date());
    state.plan = [];
    render();
  }

  document.querySelectorAll(".nav-link").forEach((button) => button.addEventListener("click", () => handleViewClick(button.dataset.view)));
  document.querySelectorAll(".space-link").forEach((button) => button.addEventListener("click", () => {
    state.category = state.category === button.dataset.category ? null : button.dataset.category;
    state.view = "day";
    state.plan = [];
    render();
  }));
  document.querySelectorAll(".view-option").forEach((button) => button.addEventListener("click", () => handleViewClick(button.dataset.display)));
  document.querySelectorAll(".date-step").forEach((button) => button.addEventListener("click", () => {
    state.selectedDate = shiftDate(state.selectedDate, Number(button.dataset.step) * (state.view === "week" ? 7 : 1));
    state.category = null;
    const date = fromDateKey(state.selectedDate);
    state.currentMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    render();
  }));
  document.querySelectorAll(".mini-month-step").forEach((button) => button.addEventListener("click", () => {
    state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() + Number(button.dataset.step), 1);
    renderMiniCalendar();
  }));
  el("go-today").addEventListener("click", () => {
    state.selectedDate = toDateKey(new Date());
    state.currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    state.view = "day";
    state.category = null;
    render();
  });
  el("new-task-button").addEventListener("click", () => openTaskDialog());
  el("capture-form").addEventListener("submit", captureTask);
  el("task-form").addEventListener("submit", saveTask);
  el("dialog-cancel").addEventListener("click", () => dialog.close());
  el("dialog-close").addEventListener("click", () => dialog.close());
  el("plan-day-button").addEventListener("click", planMyDay);
  el("theme-select").addEventListener("change", (event) => changeTheme(event.target.value));
  el("notification-button").addEventListener("click", enableNotifications);
  el("sort-button").addEventListener("click", () => {
    state.sortByPriority = !state.sortByPriority;
    el("sort-button").innerHTML = `${state.sortByPriority ? "Priority" : "Time"} <span aria-hidden="true">⌄</span>`;
    renderTasks();
  });
  el("export-calendar-button").addEventListener("click", () => {
    const tasks = getCalendarExportTasks();
    if (!tasks.length) {
      showToast("There are no tasks in this view to export.");
      return;
    }
    const filename = `daylight-${state.view === "week" ? "week" : state.view === "upcoming" ? "upcoming" : state.view === "completed" ? "completed" : "day"}.ics`;
    downloadCalendarTasks(tasks, filename);
    showToast(`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} exported. Open the .ics file to add to your calendar.`);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey && !dialog.open && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      openTaskDialog();
    }
  });
  window.setInterval(checkReminders, 15_000);
  window.setInterval(() => {
    try {
      if (navigator.onLine && state.userId && localStorage.getItem(PENDING_SYNC_KEY) === "1") queueDatabaseSync();
    } catch (error) {
      console.error("Could not check the database sync status.", error);
    }
  }, 30_000);
  window.addEventListener("focus", checkReminders);
  window.addEventListener("online", queueDatabaseSync);
  applyTheme(state.theme);
  render();
  initializeDatabase();
})();
