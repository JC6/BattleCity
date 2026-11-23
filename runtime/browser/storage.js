// Linked into the Emscripten module so the filesystem is available before main.
let storageReady = false;
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
    addRunDependency('load-states');
    FS.mkdir('/local');
    FS.mount(IDBFS, {}, '/local');
    FS.syncfs(true, function (error) {
        storageReady = !error;
        if (error) report('Browser storage is unavailable.');
        removeRunDependency('load-states');
    });
});

// Serialize writes so a second save made during a flush reaches IndexedDB too.
let savingState = false;
let pendingMessage = null;
Module.persistGameState = function persistGameState(message = 'Game saved.') {
    if (!storageReady) {
        report('Browser storage is unavailable. The save is only available in this tab.');
        return;
    }
    if (savingState) {
        pendingMessage = message;
        return;
    }
    savingState = true;
    FS.syncfs(false, function (error) {
        savingState = false;
        if (pendingMessage !== null) {
            const next = pendingMessage;
            pendingMessage = null;
            persistGameState(next);
        } else {
            report(error ? 'Could not persist the save in browser storage.' : message);
        }
    });
};

Module.stateLoaded = function () {
    report('Game loaded.');
};

Module.stateRewound = function () {
    report('Game rewound.');
};
