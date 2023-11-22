"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistedState = void 0;
const deepmerge_1 = __importDefault(require("deepmerge"));
const electron_store_1 = __importDefault(require("electron-store"));
require("electron");
const helpers_1 = require("./helpers");
/**
* Persist and rehydrate your [Vuex](https://vuex.vuejs.org/) state in your [Electron](https://electronjs.org) app
*/
class PersistedState {
    constructor(inputOpts, store) {
        const defaultOptions = {
            fileName: 'vuex',
            storageKey: 'state',
            reducer: helpers_1.reducer,
            arrayMerger: helpers_1.combineMerge,
            overwrite: false,
            checkStorage: true,
            dev: false,
            ipc: false
        };
        this.opts = Object.assign({}, defaultOptions, inputOpts);
        this.store = store;
        // Generate electron-store migrations from migrate state functions
        const migrations = {};
        if (inputOpts.migrations && !this.opts.dev) {
            Object.entries(inputOpts.migrations).forEach(([version, migrate]) => {
                migrations[version] = (store) => {
                    const state = store.get(this.opts.storageKey);
                    migrate(state);
                    store.set(this.opts.storageKey, state);
                };
            });
        }
        // Create new electron-store instance
        if (!inputOpts.storage) {
            this.opts.storage = new electron_store_1.default({
                name: this.opts.fileName,
                encryptionKey: this.opts.encryptionKey,
                cwd: this.opts.storageFileLocation,
                migrations
            });
        }
    }
    getState() {
        return this.opts.storage.get(this.opts.storageKey);
    }
    setState(state) {
        this.opts.storage.set(this.opts.storageKey, state);
    }
    clearState() {
        this.opts.storage.clear();
    }
    checkStorage() {
        try {
            const testKey = '@@';
            this.opts.storage.set(testKey, 1);
            this.opts.storage.get(testKey);
            this.opts.storage.delete(testKey);
        }
        catch (error) {
            throw new Error('[Vuex Electron] Storage is not valid. Please, read the docs.');
        }
    }
    loadInitialState() {
        const persistedState = this.getState();
        if (!persistedState)
            return;
        if (this.opts.overwrite)
            return this.store.replaceState(persistedState);
        const mergedState = (0, deepmerge_1.default)(this.store.state, persistedState, {
            arrayMerge: this.opts.arrayMerger
        });
        this.store.replaceState(mergedState);
    }
    subscribeOnChanges() {
        this.store.subscribe((mutation, state) => {
            if (this.opts.resetMutation && mutation.type === this.opts.resetMutation)
                return this.clearState();
            if (this.opts.filter && this.opts.filter(mutation))
                return;
            this.setState(this.opts.reducer(state, this.opts.paths));
        });
    }
    initIpcConnectionToMain(ipcRenderer) {
        ipcRenderer.on(helpers_1.ipcEvents.COMMIT, (_event, { type, payload, options }) => {
            this.store.commit(type, payload, options);
        });
        ipcRenderer.on(helpers_1.ipcEvents.DISPATCH, (_event, { type, payload, options }) => {
            this.store.dispatch(type, payload, options);
        });
        ipcRenderer.on(helpers_1.ipcEvents.CLEAR_STATE, () => {
            this.clearState();
        });
        ipcRenderer.on(helpers_1.ipcEvents.GET_STATE, () => {
            ipcRenderer.invoke(helpers_1.ipcEvents.GET_STATE, JSON.stringify(this.store.state)).then();
        });
        this.recallConnection(ipcRenderer);
    }
    // Fire events to the backend to get the connection.
    recallConnection(ipcRenderer) {
        const handler = setInterval(() => __awaiter(this, void 0, void 0, function* () {
            yield ipcRenderer.invoke(helpers_1.ipcEvents.CONNECT);
        }), 1000);
        ipcRenderer.on(helpers_1.ipcEvents.CONNECT_RECEIVED, () => {
            clearInterval(handler);
        });
    }
    /**
     * Listen for an IPC connection from the renderer and return an interface to it's Vuex Store.
     *
     * Requires `ipc` mode to be enabled in the plugin.
     *
     * Needs to be called in the main process and only supports one connected renderer.
     *
     * Note: Will timeout after 10 seconds if no renderer is connected.
     * @returns {Object} Methods to interact with the renderer's Vuex Store
     * @example
     * ```
        // In the main process
        import PersistedState from 'vuex-electron-store'

        const store = await PersistedState.getStoreFromRenderer()

        // Commit a mutation
        store.commit(type, payload, options)

        // Dispatch an action
        store.dispatch(type, payload, options)

        // Get the current Vuex State
        const state = await store.getState()

        // Reset the persisted State
        store.clearState()
        ```
    */
    static getStoreFromRenderer(ipcMain) {
        // Abitrary timeout to wait for the renderer to connect
        const ipcTimeout = 10000;
        const storePromise = new Promise((resolve) => {
            if (process.type === 'renderer')
                throw new Error('[Vuex Electron] Only call `.getStoreFromRenderer()` in the main process.');
            // // Init electron-store
            PersistedState.initRenderer();
            let connection;
            const commit = (type, payload, options) => {
                if (!connection)
                    throw new Error('[Vuex Electron] Not connected to renderer.');
                connection.send(helpers_1.ipcEvents.COMMIT, { type, payload, options });
            };
            const dispatch = (type, payload, options) => {
                if (!connection)
                    throw new Error('[Vuex Electron] Not connected to renderer.');
                connection.send(helpers_1.ipcEvents.DISPATCH, { type, payload, options });
            };
            const getState = () => {
                if (!connection)
                    throw new Error('[Vuex Electron] Not connected to renderer.');
                const uponHandler = new Promise((res) => {
                    ipcMain.handle(helpers_1.ipcEvents.GET_STATE, (event, data) => {
                        res(JSON.parse(data));
                    });
                });
                connection.send(helpers_1.ipcEvents.GET_STATE);
                return uponHandler;
            };
            const clearState = () => {
                if (!connection)
                    throw new Error('[Vuex Electron] Not connected to renderer.');
                connection.send(helpers_1.ipcEvents.CLEAR_STATE);
            };
            ipcMain.handle(helpers_1.ipcEvents.CONNECT, (event) => {
                connection = event.sender;
                resolve({ commit, dispatch, getState, clearState });
                // Terminate the frontend recall
                connection.send(helpers_1.ipcEvents.CONNECT_RECEIVED);
                // Remove connection when window is closed
                connection.on('destroyed', () => {
                    connection = undefined;
                });
            });
        });
        // Reject if renderer takes more than ipcTimeout to connect
        const timeout = new Promise((_r, reject) => setTimeout(() => {
            reject(new Error('[Vuex Electron] Reached timeout while waiting for renderer to connect.'));
        }, ipcTimeout));
        return Promise.race([storePromise, timeout]);
    }
    /**
     * Create a new Vuex plugin which initializes the [electron-store](https://github.com/sindresorhus/electron-store), rehydrates the state and persistently stores any changes
     * @returns The Vuex Plugin
     * @example
     ```
     import Vue from 'vue'
     import Vuex from 'vuex'

     import PersistedState from 'vuex-electron-store'

     Vue.use(Vuex)

     export default new Vuex.Store({
     // ...
     plugins: [
     PersistedState.create()
     ],
     // ...
     })
     ```
     * @param options - Default payload to persisted state
     * @param ipcRenderer - Electron ipcRenderer object (only when options.ipc is set to `true`)
     */
    static create(options = {}, ipcRenderer) {
        return (store) => {
            const persistedState = new PersistedState(options, store);
            if (persistedState.opts.checkStorage) {
                persistedState.checkStorage();
            }
            if (!persistedState.opts.dev) {
                persistedState.loadInitialState();
                persistedState.subscribeOnChanges();
            }
            if (persistedState.opts.ipc) {
                persistedState.initIpcConnectionToMain(ipcRenderer);
            }
        };
    }
    /**
     * Initializer to set up the required `ipc` communication channels for the [electron-store](https://github.com/sindresorhus/electron-store) module.
     * Needs to be called in the Electron main process.
    */
    static initRenderer() {
        electron_store_1.default.initRenderer();
    }
}
exports.PersistedState = PersistedState;
