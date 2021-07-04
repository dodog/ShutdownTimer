/**
    AUTHOR: Daniel Neumann, Deminder
    GJS SOURCES: https://github.com/GNOME/gnome-shell/
    BUILD: ./scripts/build.sh
    UPDATE TRANSLATIONS: ./scripts/update-pod.sh
**/

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { RootMode, Timer, Convenience } = Me.imports.lib;
const logDebug = Convenience.logDebug;

/* IMPORTS */
const { GObject, GLib, St, Gio, Clutter } = imports.gi;

// screen and main functionality
const Main = imports.ui.main;

// menu items
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;
const Switcher = imports.ui.switcherPopup;
const PadOsd = imports.ui.padOsd;

// translations
const Gettext = imports.gettext.domain("ShutdownTimer");
const _ = Gettext.gettext;

/* GLOBAL VARIABLES */
let textbox,
  shutdowTimerMenu,
  separator,
  settings,
  checkCancel,
  rootMode;
let initialized = false;
const MODE_LABELS = Me.imports.prefs.MODE_LABELS;
const WAKE_MODE_LABELS = {
  wake: _("Wake after"),
  "no-wake": _("No Wake"),
};
const MODE_TEXTS = {
  suspend: _("suspend"),
  poweroff: _("shutdown"),
  reboot: _("reboot"),
  wake: _("wakeup"),
};

class ScheduleInfo {
  constructor({ mode = "?", deadline = -1, external = false }) {
    this._v = { mode, deadline, external };
  }

  copy(vals) {
    return new ScheduleInfo({ ...this._v, ...vals });
  }

  get deadline() {
    return this._v.deadline;
  }

  get external() {
    return this._v.external;
  }

  get mode() {
    return this._v.mode;
  }

  get scheduled() {
    return this.deadline > -1;
  }

  get secondsLeft() {
    return this.deadline - GLib.DateTime.new_now_utc().to_unix();
  }

  get minutes() {
    return Math.floor(this.secondsLeft / 60);
  }

  get modeText() {
    return this.mode in MODE_TEXTS
      ? MODE_TEXTS[this.mode]
      : MODE_TEXTS["poweroff"];
  }

  get label() {
    let label = _("Shutdown Timer");
    if (this.scheduled) {
      label =
        `${durationString(this.secondsLeft)} ${_("until")} ${this.modeText}` +
        (this.external ? " " + _("(sys)") : "");
    }
    return label;
  }

  isMoreUrgendThan(otherInfo) {
    return (
      !otherInfo.scheduled ||
      (this.scheduled && this.deadline < otherInfo.deadline)
    );
  }
}

// show textbox with message
function _showTextbox(textmsg) {
  if (!settings.get_boolean("show-textboxes-value")) {
    return;
  }
  if (!textbox) {
    textbox = new St.Label({
      style_class: "textbox-label",
      text: "Hello, world!",
    });
    Main.uiGroup.add_actor(textbox);
  }
  textbox.text = textmsg;
  textbox.opacity = 255;
  let monitor = Main.layoutManager.primaryMonitor;
  textbox.set_position(
    Math.floor(monitor.width / 2 - textbox.width / 2),
    Math.floor(monitor.height / 2 - textbox.height / 2)
  );
  textbox.ease({
    opacity: 0,
    delay: 3000,
    duration: 1000,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    onComplete: _hideTextbox,
  });
}

function _hideTextbox() {
  Main.uiGroup.remove_actor(textbox);
  textbox = null;
}

async function maybeStopRootModeProtection(info, stopScheduled = false) {
  if (
    (stopScheduled || !info.scheduled) &&
    settings.get_boolean("root-mode-value")
  ) {
    logDebug("Stop root mode protection for: " + info.mode);
    try {
      switch (info.mode) {
        case "poweroff":
        case "reboot":
          await rootMode.shutdownCancel();
          break;
        default:
          logDebug("No root mode protection stopped for: " + info.mode);
      }
    } catch (err) {
      guiIdle(() =>
        _showTextbox(_("Root mode protection failed!") + "\n" + err)
      );
      logErr(err, "DisableRootModeProtection");
    }
  }
}

/**
 *
 * Insure that shutdown is executed even if the GLib timer fails by running
 * shutdown in rootMode delayed by 1 minute. Suspend is not insured.
 *
 */
async function maybeStartRootModeProtection(info) {
  if (info.scheduled && settings.get_boolean("root-mode-value")) {
    logDebug("Start root mode protection for: " + info.label);
    try {
      switch (info.mode) {
        case "poweroff":
          await rootMode.shutdown(info.minutes + 1);
          break;
        case "reboot":
          await rootMode.shutdown(info.minutes + 1, true);
          break;
        default:
          logDebug("No root mode protection started for: " + info.mode);
      }
    } catch (err) {
      guiIdle(() =>
        _showTextbox(_("Root mode protection failed!") + "\n" + err)
      );
      logErr(err, "EnableRootModeProtection");
    }
  }
}

// timer action (shutdown/reboot/suspend)
function serveInernalSchedule(mode) {
  maybeDoCheck()
    .then(() => {
      // check succeeded: do shutdown
      shutdown(mode);
    })
    .catch((err) => {
      logError(err, "CheckError");
      // check failed: cancel shutdown
      if (settings.get_boolean("root-mode-value")) {
        rootMode.shutdownCancel();
      }
      if (settings.get_boolean("auto-wake-value")) {
        rootMode.wakeCancel();
      }
    })
    .finally(() => {
      // reset schedule timestamp
      settings.set_int("shutdown-timestamp-value", -1);
      guiIdle(() => {
        shutdowTimerMenu._updateSwitcherState();
      });
    });
}

async function maybeDoCheck() {
  if (checkCancel !== null) {
    throw new Error(
      "Confirmation canceled: attempted to start a second check command!"
    );
  }
  checkCancel = new Gio.Cancellable();

  const checkCmd = maybeCheckCmdString();
  if (checkCmd === "") {
    return;
  }
  if (
    settings.get_boolean("root-mode-value") &&
    settings.get_boolean("enable-root-mode-cancel-value")
  ) {
    // avoid shutting down (with root mode protection) before check command is done
    rootMode.shutdownCancel();
  }
  guiIdle(() => {
    shutdowTimerMenu._updateShutdownInfo();
    _showTextbox(_("Waiting for confirmation") + maybeCheckCmdString(true));
  });
  return RootMode.execCheck(checkCmd, checkCancel)
    .then(() => {
      logDebug(`Check command "${checkCmd}" confirmed shutdown.`);
      return;
    })
    .catch((err) => {
      let code = "?";
      if ("code" in err) {
        code = `${err.code}`;
        logDebug("Check command aborted shutdown. Code: " + code);
      }
      guiIdle(() => {
        _showTextbox(_("Shutdown aborted") + `\n${checkCmd} (Code: ${code})`);
      });
      throw err;
    })
    .finally(() => {
      checkCancel = null;
    });
}

async function wakeAction(mode) {
  switch (mode) {
    case "wake":
      return await rootMode.wake(_getSliderMinutes("wake"));
    case "no-wake":
      return await rootMode.wakeCancel();
    default:
      logError(new Error("Unknown wake mode: " + mode));
      return false;
  }
}

function shutdown(mode) {
  Main.overview.hide();
  const session = new imports.misc.gnomeSession.SessionManager();
  const LoginManager = imports.misc.loginManager;
  const loginManager = LoginManager.getLoginManager();

  switch (mode) {
    case "reboot":
      session.RebootRemote(0);
      break;
    case "suspend":
      loginManager.suspend();
    default:
      session.ShutdownRemote(0); // shutdown after 60s
      // const Util = imports.misc.util;
      // Util.spawnCommandLine('poweroff');	// shutdown immediately
      break;
  }
}

// Derived values
function durationString(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours >= 3) {
    return `${hours} ${_("hours")}`;
  }
  if (minutes === 0) {
    return `${seconds} ${_("seconds")}`;
  }
  return `${minutes} ${_("minutes")}`;
}

function _getSliderMinutes(prefix) {
  let sliderValue = settings.get_int(prefix + "-slider-value") / 100.0;
  return Math.floor(
    sliderValue * settings.get_int(prefix + "-max-timer-value")
  );
}

function maybeCheckCmdString(nl = false) {
  const cmd = settings.get_string("check-command-value");
  return settings.get_boolean("enable-check-command-value") && cmd !== ""
    ? (nl ? "\n" : "") + cmd
    : "";
}

/* --- GUI main loop ---- */

/* ACTION FUNCTIONS */

function stopSchedule() {
  settings.set_int("shutdown-timestamp-value", -1);
  let showText = _("Shutdown Timer stopped");
  if (checkCancel !== null) {
    checkCancel.cancel();
    showText = _("Confirmation canceled");
  }
  _showTextbox(showText);
}

function startSchedule() {
  const maxTimerMinutes = _getSliderMinutes("shutdown");
  settings.set_int(
    "shutdown-timestamp-value",
    GLib.DateTime.new_now_utc().to_unix() + maxTimerMinutes * 60
  );
  _showTextbox(
    `${_("System will shutdown in")} ${maxTimerMinutes} ${_(
      "minutes"
    )}${maybeCheckCmdString(true)}`
  );
}

function _disconnectOnDestroy(item, connections) {
  const handlerIds = connections.map(([label, func]) =>
    item.connect(label, func)
  );
  const destoryId = item.connect("destroy", () => {
    handlerIds.concat(destoryId).forEach((handlerId) => {
      item.disconnect(handlerId);
    });
  });
}

function guiIdle(func) {
  if (shutdowTimerMenu !== null) {
    shutdowTimerMenu.guiIdle(func);
  }
}

function _createSliderItem(settingsPrefix) {
  const sliderValue =
    settings.get_int(settingsPrefix + "-slider-value") / 100.0;
  const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
  const sliderIcon = new St.Icon({
    icon_name:
      settingsPrefix === "wake"
        ? "alarm-symbolic"
        : "preferences-system-time-symbolic",
    style_class: "popup-menu-icon",
  });
  item.add(sliderIcon);
  const slider = new Slider.Slider(sliderValue);
  _disconnectOnDestroy(slider, [
    [
      "notify::value",
      () => {
        settings.set_int(settingsPrefix + "-slider-value", slider.value * 100);
      },
    ],
  ]);
  item.add_child(slider);
  return [item, slider];
}

const ShutdownTimer = GObject.registerClass(
  class ShutdownTimer extends PopupMenu.PopupSubMenuMenuItem {
    _init() {
      super._init("", true);
      this.idleSourceIds = {};
      this.externalScheduleInfo = new ScheduleInfo({ external: true });
      this.externalWakeInfo = new ScheduleInfo({
        external: false,
        mode: "wake",
      });
      this.internalScheduleInfo = new ScheduleInfo({
        external: false,
        deadline: settings.get_int("shutdown-timestamp-value"),
        mode: settings.get_string("shutdown-mode-value"),
      });

      // submenu in status area menu with slider and toggle button
      this.sliderItems = {};
      this.sliders = {};
      ["shutdown", "wake"].forEach((prefix) => {
        const [item, slider] = _createSliderItem(prefix);
        this.sliderItems[prefix] = item;
        this.sliders[prefix] = slider;
        this._onShowSliderChanged(prefix);
      });
      this.switcher = new PopupMenu.PopupSwitchMenuItem("", false);
      _disconnectOnDestroy(this.switcher, [["toggled", this._onToggle.bind(this)]]);
      this.switcherSettingsButton = new St.Button({
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: _("Settings"),
        style_class: "system-menu-action settings-button",
      });
      this.switcherSettingsButton.child = new St.Icon({
        icon_name: "emblem-system-symbolic",
        style_class: "popup-menu-icon",
      });
      _disconnectOnDestroy(this.switcherSettingsButton, [
        [
          "clicked",
          () => {
            ExtensionUtils.openPrefs();
          },
        ],
      ]);
      this.switcher.add_child(this.switcherSettingsButton);

      this._onShowSettingsButtonChanged();
      this._updateSwitchLabel();
      this.icon.icon_name = "system-shutdown-symbolic";
      this.menu.addMenuItem(this.switcher);
      // make switcher toggle without popup menu closing
      this.switcher.disconnect(this.switcher._activateId);
      // dummy for clean disconnect
      this.switcher._activateId = this.switcher.connect_after(
        "activate",
        () => {}
      );
      this.menu.addMenuItem(this.sliderItems["shutdown"]);

      this.modeItems = Object.entries(MODE_LABELS).map(([mode, label]) => {
        const modeItem = new PopupMenu.PopupMenuItem(label);
        _disconnectOnDestroy(modeItem, [
          [
            "activate",
            () => {
              this._startMode(mode);
            },
          ],
        ]);
        this.menu.addMenuItem(modeItem);
        return [mode, modeItem];
      });

      this.wakeItems = [
        new PopupMenu.PopupSeparatorMenuItem(),
        this.sliderItems["wake"],
        ...Object.entries(WAKE_MODE_LABELS).map(([mode, label]) => {
          const modeItem = new PopupMenu.PopupMenuItem(label);
          if (mode === "wake") {
            this.wakeModeItem = modeItem;
          }
          _disconnectOnDestroy(modeItem, [
            [
              "activate",
              () => {
                wakeAction(mode).then((success) => {
                  if (success) {
                    guiIdle(() => {
                      rootMode.updateScheduleInfo();
                    });
                  }
                });
              },
            ],
          ]);
          return modeItem;
        }),
      ];
      this._updateWakeModeItem();
      this.wakeItems.forEach((item) => {
        this.menu.addMenuItem(item);
      });
      this._updateShownWakeItems();
      this._updateShownModeItems();
      this._updateSelectedModeItems();
      timer.setTickCallback(this._updateShutdownInfo.bind(this));
      this._onInternalShutdownTimestampChanged();

      // start root mode update loop
      rootMode.startScheduleInfoLoop(
        this._externalScheduleInfoTick.bind(this),
        this._onRootActiveChanged.bind(this)
      );

      // handlers for changed values in settings
      this.settingsHandlerIds = [
        ["shutdown-max-timer-value", this._updateSwitchLabel.bind(this)],
        ["wake-max-timer-value", this._updateWakeModeItem.bind(this)],
        [
          "shutdown-slider-value",
          () => {
            this._updateSlider("shutdown");
            this._updateSwitchLabel();
          },
        ],
        [
          "wake-slider-value",
          () => {
            this._updateSlider("wake");
            this._updateWakeModeItem();
          },
        ],
        ["root-mode-value", this._onRootModeChanged.bind(this)],
        ["show-settings-value", this._onShowSettingsButtonChanged.bind(this)],
        [
          "show-shutdown-slider-value",
          () => this._onShowSliderChanged("shutdown"),
        ],
        ["show-wake-slider-value", () => this._onShowSliderChanged("wake")],
        ["show-wake-items-value", this._updateShownWakeItems.bind(this)],
        ["show-shutdown-mode-value", this._updateShownModeItems.bind(this)],
        ["shutdown-mode-value", this._onModeChange.bind(this)],
        ["shutdown-timestamp-value", this._onInternalShutdownTimestampChanged.bind(this)],
      ].map(([label, func]) => settings.connect("changed::" + label, func));
    }

    guiIdle(func) {
      const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        func();
        delete this.idleSourceIds[sourceId];
        return GLib.SOURCE_REMOVE;
      });
      this.idleSourceIds[sourceId] = 1;
    }

    _onRootModeChanged() {
      if (!settings.get_boolean("root-mode-value")) {
        rootMode.stopRootProc();
      }
      Promise.all([
        maybeStopRootModeProtection(this.internalScheduleInfo),
        maybeStartRootModeProtection(this.internalScheduleInfo),
      ]).then(() => {
        rootMode.updateScheduleInfo();
        this._updateSwitchLabel();
      });
    }

    _onModeChange() {
      // redo Root-mode protection
      maybeStopRootModeProtection(this.internalScheduleInfo, true)
        .then(() => {
          this._updateCurrentMode();
          logDebug("Shutdown mode: " + this.internalScheduleInfo.mode);
          this.guiIdle(() => {
            this._updateSelectedModeItems();
            rootMode.updateScheduleInfo();
          });
        })
        .then(() => maybeStartRootModeProtection(this.internalScheduleInfo));
    }

    _updateCurrentMode() {
      this.internalScheduleInfo = this.internalScheduleInfo.copy({
        mode: settings.get_string("shutdown-mode-value"),
      });
      this._updateShutdownInfo();
    }

    _onInternalShutdownTimestampChanged() {
      this.internalScheduleInfo = this.internalScheduleInfo.copy({
        deadline: settings.get_int("shutdown-timestamp-value"),
      });

      timer.adjustTo(this.internalScheduleInfo);
      this._updateShutdownInfo();
    }

    /* Schedule Info updates */
    _externalScheduleInfoTick(info, wakeInfo) {
      this.externalScheduleInfo = this.externalScheduleInfo.copy({ ...info });
      this.externalWakeInfo = this.externalWakeInfo.copy({ ...wakeInfo });
      this.guiIdle(() => {
        this._updateShutdownInfo();
      });
    }

    _onRootActiveChanged() {
      this._updateSwitchLabel();
    }

    _updateSwitcherState() {
      this.switcher.setToggleState(this.internalScheduleInfo.scheduled);
    }

    _updateShownModeItems() {
      const activeModes = settings
        .get_string("show-shutdown-mode-value")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s in MODE_LABELS);
      this.modeItems.forEach(([mode, item]) => {
        const position = activeModes.indexOf(mode);
        if (position > -1) {
          this.menu.moveMenuItem(item, position + 2);
        }
        item.visible = position > -1;
      });
    }

    _updateShutdownInfo() {
      let wakeLabel = this.externalWakeInfo.scheduled
        ? "\n" + this.externalWakeInfo.label
        : "";

      if (checkCancel !== null) {
        this.label.text = _("Waiting for confirmation") + wakeLabel;
        return;
      }
      const info = this.externalScheduleInfo.isMoreUrgendThan(
        this.internalScheduleInfo
      )
        ? this.externalScheduleInfo
        : this.internalScheduleInfo;
      this.label.text = info.label + wakeLabel;
    }

    _updateSelectedModeItems() {
      this.modeItems.forEach(([mode, item]) => {
        item.setOrnament(
          mode === this.internalScheduleInfo.mode
            ? PopupMenu.Ornament.DOT
            : PopupMenu.Ornament.NONE
        );
      });
    }

    // update timer value if slider has changed
    _updateSlider(prefix) {
      this.sliders[prefix].value =
        settings.get_int(prefix + "-slider-value") / 100.0;
    }

    _updateSwitchLabel() {
      let label = `${_getSliderMinutes("shutdown")} ${_("min")}`;
      if (rootMode.isActive()) {
        label += " " + _("(root)");
      }
      this.switcher.label.text = label;
    }

    _updateWakeModeItem() {
      const minutes = _getSliderMinutes("wake");
      const hours = Math.floor(minutes / 60);
      const hoursStr = hours !== 0 ? `${hours} ${_("hours")} ` : "";
      this.wakeModeItem.label.text =
        WAKE_MODE_LABELS["wake"] +
        ` ${hoursStr}${minutes % 60} ${_("minutes")}`;
    }

    _onShowSettingsButtonChanged() {
      this.switcherSettingsButton.visible = settings.get_boolean(
        "show-settings-value"
      );
    }

    _updateShownWakeItems() {
      this.wakeItems.forEach((item) => {
        item.visible = settings.get_boolean("show-wake-items-value");
      });
      this._onShowSliderChanged("wake");
    }

    _onShowSliderChanged(settingsPrefix) {
      this.sliderItems[settingsPrefix].visible =
        (settingsPrefix !== "wake" ||
          settings.get_boolean("show-wake-items-value")) &&
        settings.get_boolean(`show-${settingsPrefix}-slider-value`);
    }

    _startMode(mode) {
      startSchedule();
      settings.set_string("shutdown-mode-value", mode);
      this._updateSwitcherState();
    }

    // toggle button starts/stops shutdown timer
    _onToggle() {
      if (this.switcher.state) {
        // start shutdown timer
        startSchedule();
        maybeStartRootModeProtection(this.internalScheduleInfo).then(
          async () => {
            if (settings.get_boolean("auto-wake-value")) {
              await rootMode.wake(_getSliderMinutes("wake"));
            }
            rootMode.updateScheduleInfo();
          }
        );
      } else {
        // stop shutdown timer
        stopSchedule();
        maybeStopRootModeProtection(this.internalScheduleInfo).then(
          async () => {
            if (settings.get_boolean("auto-wake-value")) {
              await rootMode.wakeCancel();
            }
            rootMode.updateScheduleInfo();
          }
        );
      }
    }

    destroy() {
      timer.setTickCallback(null);
      timer.stopGLibTimer();
      rootMode.stopScheduleInfoLoop();
      this.settingsHandlerIds.forEach((handlerId) => {
        settings.disconnect(handlerId);
      });
      Object.keys(this.idleSourceIds).forEach((sourceId) => {
        GLib.Source.remove(sourceId);
      });
      super.destroy();
    }
  }
);

/* EXTENSION MAIN FUNCTIONS */
function init() {
  // initialize translations
  ExtensionUtils.initTranslations();
}

function enable() {
  if (!initialized) {
    // initialize settings
    settings = ExtensionUtils.getSettings();

    // check for shutdown may run in background and can be canceled by user
    checkCancel = null;
    // track external schutdown and wake schedule
    // keeps track of priviledged process (for root mode)
    rootMode = new RootMode.RootMode();
    // starts internal shutdown schedule if ready
    timer = new Timer.Timer(serveInernalSchedule);

    initialized = true;
  }

  // add separator line and submenu in status area menu
  separator = new PopupMenu.PopupSeparatorMenuItem();
  const statusMenu = Main.panel.statusArea["aggregateMenu"];
  statusMenu.menu.addMenuItem(separator);
  shutdowTimerMenu = new ShutdownTimer();
  statusMenu.menu.addMenuItem(shutdowTimerMenu);
}

function disable() {
  shutdowTimerMenu.destroy();
  shutdowTimerMenu = null;
  separator.destroy();
  separator = null;
}
