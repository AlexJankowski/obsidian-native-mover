import { Notice, Plugin, TFile, TAbstractFile, Setting, PluginSettingTab } from 'obsidian';

export interface MyPluginSettings {
	forcePermanentDelete: boolean;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	forcePermanentDelete: false
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: any, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		
		new Setting(containerEl)
			.setName('Permanently Delete Original on Move')
			.setDesc('DANGEROUS: If enabled, moving a file will PERMANENTLY DELETE the original file bypassing all Trash bins. Only enable this if you are absolutely sure. If a native drag is interrupted, your file could be lost forever!')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.forcePermanentDelete)
				.onChange(async (value) => {
					this.plugin.settings.forcePermanentDelete = value;
					await this.plugin.saveSettings();
				}));
	}
}

const PLUGIN_PREFIX = "NativeMover";

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	// Keep a reference to the bound handlers so we can remove them
	private boundDragStartHandler: (evt: DragEvent) => void;

	async onload() {
		await this.loadSettings();

		// Bind the handlers
		this.boundDragStartHandler = this.handleDragStart.bind(this);

		// 1. USE CAPTURE PHASE
		// Attach to document with capture: true, so we intercept the dragstart
		// BEFORE Obsidian's own handlers on .nav-file-title fire
		document.addEventListener('dragstart', this.boundDragStartHandler, true);

		// Clean up on unload
		this.register(() => {
			document.removeEventListener('dragstart', this.boundDragStartHandler, true);
		});

		// Settings tab
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Let the user know it loaded
		new Notice(`${PLUGIN_PREFIX}: Plugin loaded`);
		console.log(`${PLUGIN_PREFIX}: Plugin loaded & event listener registered (capture phase).`);
	}

	onunload() {
		console.log(`${PLUGIN_PREFIX}: Plugin unloaded.`);
	}

	// ──────────────────────────────────────────────
	//  Core drag-start handler
	// ──────────────────────────────────────────────
	private handleDragStart(evt: DragEvent): void {
		// Only act on elements with the .nav-file-title or .nav-folder-title class
		const target = evt.target as HTMLElement | null;
		if (!target) return;

		let navElement = target.closest('.nav-file-title') as HTMLElement | null;
		if (!navElement) {
			navElement = target.closest('.nav-folder-title') as HTMLElement | null;
		}
		
		if (!navElement) return;

		// Extract the vault-relative path
		const vaultPath = navElement.getAttribute('data-path');
		if (!vaultPath) {
			console.warn(`${PLUGIN_PREFIX}: Dragged element has no data-path attribute.`);
			return;
		}

		// Resolve the Obsidian file object
		const abstractFile: TAbstractFile | null = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!abstractFile) {
			console.warn(`${PLUGIN_PREFIX}: Could not resolve vault path "${vaultPath}".`);
			return;
		}

		const file: TAbstractFile = abstractFile;

		// Resolve the absolute system path
		let absolutePath: string;
		try {
			absolutePath = (this.app.vault.adapter as any).getFullPath(file.path);
		} catch (err) {
			console.error(`${PLUGIN_PREFIX}: Failed to resolve absolute path for "${file.path}".`, err);
			return;
		}

		const isCtrl = evt.ctrlKey || evt.metaKey;
		const isAlt = evt.altKey;
		const isShift = evt.shiftKey;

		console.log(`${PLUGIN_PREFIX}: Drag detected (Ctrl/Cmd: ${isCtrl}, Shift: ${isShift}, Alt: ${isAlt}).`);

		// No modifier key → default Obsidian behavior
		if (!isCtrl && !isAlt) {
			console.log(`${PLUGIN_PREFIX}: Plain drag on "${file.name}". Allowing default Obsidian behavior (internal link).`);
			return;
		}

		// ── Native Drag Intercept ──────────────────────

		// Prevent Obsidian's internal drag handlers
		evt.stopPropagation();
		
		// ALT ONLY -> Web Shortcut Link (.url)
		if (isAlt && !isCtrl) {
			console.log(`${PLUGIN_PREFIX}: ALT+Drag detected. Creating OS URL shortcut link for "${file.name}".`);
			const absoluteUri = `file:///${absolutePath.replace(/\\/g, '/')}`;
			
			// DO NOT preventDefault() here! If we prevent default, Chrome cancels the HTML5 drag.
			evt.dataTransfer?.clearData();
			// text/uri-list tells Windows Desktop to create a .url file pointing to the file path
			evt.dataTransfer?.setData('text/uri-list', absoluteUri);
			evt.dataTransfer?.setData('text/plain', absoluteUri);
			return;
		}

		// CTRL + ALT -> Native Move
		// CTRL ONLY -> Native Copy
		if (isCtrl) {
			// CRITICAL: Stop Chrome's default link-drag behavior to let Electron Native Drag take over
			evt.preventDefault();
			evt.dataTransfer?.clearData();

			const isMove = isAlt; // If Alt is also held with Ctrl, it's a Move.
			const actionName = isMove ? "Move" : "Copy";
			console.log(`${PLUGIN_PREFIX}: ${actionName} initiated natively for "${file.name}"`);
			
			// For Move, Chrome drops connection with the OS during native drags.
			// The only mathematically safe way to know the drag is 'done' is when the
			// user returns their cursor back to Obsidian.
			if (isMove) {
				const executeTrash = async () => {
					window.removeEventListener('mouseenter', executeTrash);
					window.removeEventListener('focus', executeTrash);
					window.removeEventListener('click', executeTrash);
					console.log(`${PLUGIN_PREFIX}: User returned to Obsidian. Executing Move trash...`);
					try {
						// user setting determines whether to definitively delete (true) or move to local .trash (false)
						const forcePermanentDelete = this.settings.forcePermanentDelete;
						if (forcePermanentDelete) {
							await this.app.vault.delete(file, true);
							new Notice(`NativeMover: Moved "${file.name}" (Original PERMANENTLY DELETED)`);
						} else {
							await this.app.vault.trash(file, false); 
							new Notice(`NativeMover: Moved "${file.name}" (Original safely in Obsidian .trash)`);
						}
					} catch (e) {
						console.error(`${PLUGIN_PREFIX}: Failed to move/trash file`, e);
					}
				};
				
				// Bind to multiple return interactions. First one wins.
				setTimeout(() => {
					window.addEventListener('mouseenter', executeTrash);
					window.addEventListener('focus', executeTrash);
					window.addEventListener('click', executeTrash);
				}, 500); // 500ms delay to let the mouse leave the window safely
			}

			// Fire electron native drag
			this.attemptNativeDragFallback(absolutePath);
		}
		
		return;
	}

	private attemptNativeDragFallback(absolutePath: string) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const electron = require('electron');
			
			let iconImage;
			try {
				const transparent1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
				iconImage = electron.nativeImage.createFromDataURL(transparent1x1);
			} catch (e) {
				console.error(`${PLUGIN_PREFIX}: Failed to create nativeImage:`, e);
				iconImage = ""; // fallback
			}

			try {
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				const remote = require('@electron/remote');
				
				const wc = remote.getCurrentWebContents();
				if (typeof wc.startDrag === 'function') {
					console.log(`${PLUGIN_PREFIX}: Executing remote startDrag...`);
					
					// startDrag handles the native OS drag and drop sequence.
					wc.startDrag({
						file: absolutePath,
						icon: iconImage
					});
					console.log(`${PLUGIN_PREFIX}: startDrag executed successfully.`);
				} else {
					console.error(`${PLUGIN_PREFIX}: getCurrentWebContents() does not have startDrag. Keys:`, Object.keys(wc));
				}
			} catch (e) {
				console.log(`${PLUGIN_PREFIX}: @electron/remote failing...`, e);
			}
		} catch (e) {
			console.error(`${PLUGIN_PREFIX}: failed to require electron.`, e);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
