import merge from 'deepmerge'
import Store from 'electron-store'
import Conf from 'conf'
import 'electron'
import { Store as VuexStore, MutationPayload, Plugin, CommitOptions, DispatchOptions } from 'vuex'

import { reducer, combineMerge, ipcEvents } from './helpers'
import { Options, FinalOptions, Migrations, StoreInterface } from './types'
import IpcRenderer = Electron.IpcRenderer;
import IpcMain = Electron.IpcMain;

/**
* Persist and rehydrate your [Vuex](https://vuex.vuejs.org/) state in your [Electron](https://electronjs.org) app
*/
class PersistedState<State extends Record<string, any> = Record<string, unknown>> {

	opts: FinalOptions<State>
	store: VuexStore<any>

	constructor(inputOpts: Options<State>, store: VuexStore<State>) {
		const defaultOptions: any = {
			fileName: 'vuex',
			storageKey: 'state',
			reducer: reducer,
			arrayMerger: combineMerge,
			overwrite: false,
			checkStorage: true,
			dev: false,
			ipc: false
		}

		this.opts = Object.assign({}, defaultOptions, inputOpts)
		this.store = store

		// Generate electron-store migrations from migrate state functions
		const migrations: Migrations<State> = {}
		if (inputOpts.migrations && !this.opts.dev) {
			Object.entries(inputOpts.migrations).forEach(([version, migrate]) => {

				migrations[version] = (store: Conf<State>) => {
					const state = store.get(this.opts.storageKey)

					migrate(state)

					store.set(this.opts.storageKey, state)
				}
			})
		}

		// Create new electron-store instance
		if (!inputOpts.storage) {
			this.opts.storage = new Store({
				name: this.opts.fileName,
				encryptionKey: this.opts.encryptionKey,
				cwd: this.opts.storageFileLocation,
				migrations
			})
		}
	}

	getState(): any {
		return this.opts.storage.get(this.opts.storageKey)
	}

	setState(state: any): void {
		this.opts.storage.set(this.opts.storageKey, state)
	}

	clearState() {
		this.opts.storage.clear()
	}

	checkStorage(): void {
		try {
			const testKey = '@@'

			this.opts.storage.set(testKey, 1)
			this.opts.storage.get(testKey)
			this.opts.storage.delete(testKey)
		} catch (error) {
			throw new Error('[Vuex Electron] Storage is not valid. Please, read the docs.')
		}
	}

	loadInitialState(): void {
		const persistedState = this.getState()
		if (!persistedState) return

		if (this.opts.overwrite) return this.store.replaceState(persistedState)

		const mergedState = merge(this.store.state, persistedState, {
			arrayMerge: this.opts.arrayMerger
		})

		this.store.replaceState(mergedState)
	}

	subscribeOnChanges(): void {
		this.store.subscribe((mutation: MutationPayload, state: any) => {
			if (this.opts.resetMutation && mutation.type === this.opts.resetMutation) return this.clearState()

			if (this.opts.filter && this.opts.filter(mutation)) return

			this.setState(this.opts.reducer(state, this.opts.paths))
		})
	}

	initIpcConnectionToMain(ipcRenderer: IpcRenderer): void {
		ipcRenderer.on(ipcEvents.COMMIT, (_event, { type, payload, options }) => {
			this.store.commit(type, payload, options)
		})

		ipcRenderer.on(ipcEvents.DISPATCH, (_event, { type, payload, options }) => {
			this.store.dispatch(type, payload, options)
		})

		ipcRenderer.on(ipcEvents.CLEAR_STATE, () => {
			this.clearState()
		})

		ipcRenderer.on(ipcEvents.GET_STATE, (event) => {
			ipcRenderer.invoke(ipcEvents.GET_STATE, JSON.stringify(this.store.state)).then(() => {})
		})

		this.recallConnection(ipcRenderer);
	}
	// Fire events to the backend to get the connection.
	recallConnection(ipcRenderer: IpcRenderer): void {
		const handler = setInterval(async () => {
			await ipcRenderer.invoke(ipcEvents.CONNECT);
		}, 1000);

		ipcRenderer.on(ipcEvents.CONNECT_RECEIVED, (event) => {
			clearInterval(handler);
		})
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
	static getStoreFromRenderer<T>(ipcMain: IpcMain): Promise<StoreInterface<T> | Error> {
		// Abitrary timeout to wait for the renderer to connect
		const ipcTimeout = 10000

		const storePromise = new Promise((resolve) => {
			if (process.type === 'renderer') throw new Error('[Vuex Electron] Only call `.getStoreFromRenderer()` in the main process.')

			// // Init electron-store
			PersistedState.initRenderer()

			let connection: Electron.WebContents | undefined

			const commit: StoreInterface<T>['commit'] = (type: string, payload?: any, options?: CommitOptions) => {
				if (!connection) throw new Error('[Vuex Electron] Not connected to renderer.')

				connection.send(ipcEvents.COMMIT, { type, payload, options })
			}

			const dispatch: StoreInterface<T>['dispatch'] = (type: string, payload?: any, options?: DispatchOptions) => {
				if (!connection) throw new Error('[Vuex Electron] Not connected to renderer.')

				connection.send(ipcEvents.DISPATCH, { type, payload, options })
			}

			const getState: StoreInterface<T>['getState'] = () => {
				if (!connection) throw new Error('[Vuex Electron] Not connected to renderer.')

				const uponHandler = new Promise<T>((res) => {
					ipcMain.handle(ipcEvents.GET_STATE, (event, data) => {
						res(JSON.parse(data))
					})
				})

				connection.send(ipcEvents.GET_STATE)

				return uponHandler
			}

			const clearState: StoreInterface<T>['clearState'] = () => {
				if (!connection) throw new Error('[Vuex Electron] Not connected to renderer.')

				connection.send(ipcEvents.CLEAR_STATE)
			}

			ipcMain.handle(ipcEvents.CONNECT, (event) => {
				connection = event.sender

				resolve({ commit, dispatch, getState, clearState })

				// Terminate the frontend recall
				connection.send(ipcEvents.CONNECT_RECEIVED)

				// Remove connection when window is closed
				connection.on('destroyed', () => {
					connection = undefined
				})
			})
		})

		// Reject if renderer takes more than ipcTimeout to connect
		const timeout = new Promise((_r, reject) => setTimeout(() => {
			reject(new Error('[Vuex Electron] Reached timeout while waiting for renderer to connect.'))
		}, ipcTimeout))

		return Promise.race([ storePromise, timeout ]) as Promise<StoreInterface<T> | Error>
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
	static create <State>(options: Options<State> = {}, ipcRenderer: IpcRenderer): Plugin<State> {
		return (store: VuexStore<State>) => {
			const persistedState = new PersistedState(options, store)

			if (persistedState.opts.checkStorage) {
				persistedState.checkStorage()
			}

			if (!persistedState.opts.dev) {
				persistedState.loadInitialState()
				persistedState.subscribeOnChanges()
			}

			if (persistedState.opts.ipc) {
				persistedState.initIpcConnectionToMain(ipcRenderer)
			}
		}
	}

	/**
	 * Initializer to set up the required `ipc` communication channels for the [electron-store](https://github.com/sindresorhus/electron-store) module.
	 * Needs to be called in the Electron main process.
	*/
	static initRenderer(): void {
		Store.initRenderer()
	}
}

export { PersistedState }