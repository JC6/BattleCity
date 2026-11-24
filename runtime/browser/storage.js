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
        try {
            if (!error && copyCompatibleSlots()) {
                FS.syncfs(false, function (saveError) {
                    if (saveError) report('Could not persist the copied saves.');
                    removeRunDependency('load-states');
                });
                return;
            }
        } catch (copyError) {
            report('The previous saves could not be copied.');
        }
        removeRunDependency('load-states');
    });
});

// Stage whole slots (state, thumbnail and optional lock) before exposing them.
function copyCompatibleSlots() {
    const old = Module.compatibleSaveId, current = Module.cartridgeId;
    if (!/^[a-f0-9]{64}$/.test(old) || !/^[a-f0-9]{64}$/.test(current) || old === current) return false;
    const prior = '/local/states/' + old + '/nes';
    const target = '/local/states/' + current;
    if (!FS.analyzePath(prior).exists || FS.analyzePath(target).exists) return false;
    const slots = [1,2,3,4].map(n => n+'.sta').filter(n => FS.analyzePath(prior+'/'+n).exists);
    if (!slots.length) return false;
    const temp = '/local/states/.upgrade-'+current;
    FS.mkdir(temp);
    const files = [];
    FS.mkdir(temp+'/nes');
    try {
        for (const name of slots) {
            for (const suffix of ['', '.png', '.lock']) {
                const file = name+suffix;
                if (!FS.analyzePath(prior+'/'+file).exists) continue;
                FS.writeFile(temp+'/nes/'+file, FS.readFile(prior+'/'+file));
                files.push(file);
                const stat = FS.stat(prior+'/'+file);
                FS.utime(temp+'/nes/'+file, stat.atime.getTime(), stat.mtime.getTime());
            }
        }
        FS.rename(temp, target);
        return true;
    } catch (error) {
        for (const file of files) FS.unlink(temp+'/nes/'+file);
        FS.rmdir(temp+'/nes');
        FS.rmdir(temp);
        throw error;
    }
}

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
