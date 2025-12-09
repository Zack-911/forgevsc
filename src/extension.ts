/**
 * ForgeLSP VS Code Extension
 *
 * This extension manages the ForgeLSP language server binary, handling:
 * - Automatic download and updates of platform-specific LSP binaries from GitHub releases
 * - Binary version tracking via metadata files
 * - Language server lifecycle (start, stop, restart)
 * - Workspace configuration (forgeconfig.json creation)
 * - User commands for manual updates and config generation
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import axios from 'axios';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	ErrorAction,
	CloseAction
} from 'vscode-languageclient/node';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a single asset (binary file) from a GitHub release
 */
interface GitHubAsset {
	name: string;
	updated_at: string;
	browser_download_url: string;
}

/**
 * Represents a GitHub release with its tag and associated assets
 */
interface GitHubRelease {
	tag_name: string;
	assets: GitHubAsset[];
}

/**
 * Metadata stored alongside the binary to track version and update status
 */
interface BinaryMetadata {
	updated_at: string;
	tag_name: string;
}

// ============================================================================
// Global State
// ============================================================================

let client: LanguageClient;
let outputChannel: vscode.OutputChannel;

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * Extension activation entry point.
 *
 * Initializes the extension by:
 * - Creating an output channel for logging
 * - Registering user commands (createConfig, updateLSP)
 * - Checking for forgeconfig.json in the workspace
 * - Auto-starting the language server if config exists
 *
 * @param context - VS Code extension context providing storage and subscriptions
 */
export async function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('ForgeLSP');
	outputChannel.appendLine('ForgeLSP extension activating...');

	// Register command to create forgeconfig.json in the workspace root
	context.subscriptions.push(vscode.commands.registerCommand('forgevsc.createConfig', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showErrorMessage('ForgeLSP: No workspace open.');
			return;
		}

		const rootPath = workspaceFolders[0].uri.fsPath;
		const configPath = path.join(rootPath, 'forgeconfig.json');

		if (fs.existsSync(configPath)) {
			vscode.window.showInformationMessage('ForgeLSP: forgeconfig.json already exists.');
			return;
		}

		// Create default configuration with entry point and output directory
		const defaultConfig = {
			"multiple_function_colors": true,
			"urls": [
				"github:tryforge/forgescript#dev",
				"github:tryforge/forgedb"
			]
		};

		fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
		vscode.window.showInformationMessage('ForgeLSP: forgeconfig.json created. Please reload window to activate the extension fully if it hasn\'t already.');

		// Attempt to start the language server if it's not already running
		if (!client) {
			await startClient(context);
		}
	}));

	// Register command to manually select a custom LSP binary
	context.subscriptions.push(vscode.commands.registerCommand('forgevsc.useCustomBinary', async () => {
		const fileUri = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Select LSP Binary',
			filters: { 'Executables': ['*'] }
		});
		if (!fileUri || fileUri.length === 0) {
			vscode.window.showInformationMessage('ForgeLSP: No binary selected.');
			return;
		}
		const selectedPath = fileUri[0].fsPath;
		await context.globalState.update('customBinaryPath', selectedPath);
		vscode.window.showInformationMessage(`ForgeLSP: Custom binary set to ${selectedPath}`);
		// Restart client if already running
		if (client && client.isRunning()) {
			await client.stop();
			await startClient(context);
		}
	}));

	// Register command to reset the LSP binary to the default GitHub-hosted one
	context.subscriptions.push(vscode.commands.registerCommand('forgevsc.resetLspPath', async () => {
		await context.globalState.update('customBinaryPath', undefined);
		vscode.window.showInformationMessage('ForgeLSP: Reset to default binary path.');

		// Restart client if already running
		if (client && client.isRunning()) {
			await client.stop();
			await startClient(context);
		}
	}));

	// Register command to manually update the LSP binary to the latest version
	context.subscriptions.push(vscode.commands.registerCommand('forgevsc.updateLSP', async () => {
		const serverBinaryName = getServerBinaryName();
		if (!serverBinaryName) {
			vscode.window.showErrorMessage('ForgeLSP: Unsupported platform or architecture.');
			return;
		}

		const storagePath = context.globalStorageUri.fsPath;
		if (!fs.existsSync(storagePath)) {
			fs.mkdirSync(storagePath, { recursive: true });
		}

		let serverPath: string;
		const customPath = context.globalState.get<string>('customBinaryPath');
		if (customPath && fs.existsSync(customPath)) {
			serverPath = customPath;
			outputChannel.appendLine(`Using custom LSP binary at ${customPath}`);
		} else {
			serverPath = path.join(storagePath, serverBinaryName);
		}

		try {
			// Stop the running LSP client to avoid file locks during binary replacement
			if (client && client.isRunning()) {
				outputChannel.appendLine('Stopping LSP for update...');
				await client.stop();
				outputChannel.appendLine('LSP stopped.');
			}

			if (customPath && fs.existsSync(customPath)) {
				vscode.window.showInformationMessage('ForgeLSP: Using custom binary; update skipped.');
			} else {
				outputChannel.appendLine('Manual LSP update triggered...');
				await downloadBinary(serverBinaryName, serverPath);

				if (os.platform() !== 'win32') {
					fs.chmodSync(serverPath, '755');
				}
			}

			vscode.window.showInformationMessage('ForgeLSP binary updated successfully. Restarting LSP...');

			// Automatically restart the LSP
			await startClient(context);
		} catch (error) {
			const msg = `ForgeLSP: Failed to update binary. ${error}`;
			vscode.window.showErrorMessage(msg);
			outputChannel.appendLine(msg);

			// Attempt to restart with the existing binary if the update failed
			if (!client || !client.isRunning()) {
				try {
					await startClient(context);
				} catch (restartError) {
					outputChannel.appendLine(`Failed to restart LSP: ${restartError}`);
				}
			}
		}
	}));

	// Check for forgeconfig.json
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		outputChannel.appendLine('No workspace open, skipping auto-start.');
		return;
	}

	const rootPath = workspaceFolders[0].uri.fsPath;
	const configPath = path.join(rootPath, 'forgeconfig.json');

	if (fs.existsSync(configPath)) {
		await startClient(context);
	} else {
		outputChannel.appendLine('forgeconfig.json not found. Waiting for command or file creation.');
	}
}

// ============================================================================
// Language Server Management
// ============================================================================

/**
 * Initializes and starts the language server client.
 *
 * This function handles the complete lifecycle of starting the LSP:
 * 1. Checks if a client is already running (prevents duplicates)
 * 2. Determines the correct binary name for the current OS/architecture
 * 3. Downloads the binary if missing (with user confirmation)
 * 4. Checks for updates and prompts user to update if available
 * 5. Configures and starts the LanguageClient with proper error handling
 *
 * @param context - VS Code extension context for accessing global storage
 */
async function startClient(context: vscode.ExtensionContext) {
	if (client && client.isRunning()) {
		return;  // Prevent starting multiple client instances
	}

	const serverBinaryName = getServerBinaryName();
	if (!serverBinaryName) {
		const msg = 'ForgeLSP: Unsupported platform or architecture.';
		vscode.window.showErrorMessage(msg);
		outputChannel.appendLine(msg);
		return;
	}

	const storagePath = context.globalStorageUri.fsPath;
	if (!fs.existsSync(storagePath)) {
		fs.mkdirSync(storagePath, { recursive: true });  // Create storage directory if it doesn't exist
	}

	// Determine binary path: use custom binary if set, otherwise default storage location
	let serverPath: string;
	const customPath = context.globalState.get<string>('customBinaryPath');
	if (customPath && fs.existsSync(customPath)) {
		serverPath = customPath;
		outputChannel.appendLine(`Using custom LSP binary at ${customPath}`);
	} else {
		serverPath = path.join(storagePath, serverBinaryName);
	}

	// Handle first-time installation: prompt user to download the binary
	if (!fs.existsSync(serverPath)) {
		const userChoice = await vscode.window.showInformationMessage(
			`ForgeLSP binary not found. Download ${serverBinaryName}?`,
			'Download',
			'Cancel'
		);

		if (userChoice === 'Download') {
			try {
				await downloadBinary(serverBinaryName, serverPath);
				vscode.window.showInformationMessage('ForgeLSP binary downloaded successfully.');
			} catch (error) {
				const msg = `ForgeLSP: Failed to download binary. ${error}`;
				vscode.window.showErrorMessage(msg);
				outputChannel.appendLine(msg);
				return;
			}
		} else {
			return;
		}
	} else {
		// Binary exists: check if a newer version is available
		const updateAvailable = await shouldUpdate(serverPath, serverBinaryName);
		if (updateAvailable) {
			const userChoice = await vscode.window.showInformationMessage(
				'A new version of ForgeLSP is available. Update now?',
				'Update',
				'Skip'
			);

			if (userChoice === 'Update') {
				try {
					outputChannel.appendLine('Updating ForgeLSP binary...');
					await downloadBinary(serverBinaryName, serverPath);
					vscode.window.showInformationMessage('ForgeLSP binary updated successfully.');
				} catch (error) {
					const msg = `ForgeLSP: Failed to update binary. ${error}`;
					vscode.window.showErrorMessage(msg);
					outputChannel.appendLine(msg);
					// Continue with existing binary even if update fails
				}
			}
		}
	}

	// Ensure binary has execute permissions on Unix-like systems
	if (os.platform() !== 'win32') {
		fs.chmodSync(serverPath, '755');
	}

	// Configure how the language server process should be spawned
	const serverOptions: ServerOptions = {
		run: { command: serverPath, transport: TransportKind.stdio },
		debug: { command: serverPath, transport: TransportKind.stdio }
	};

	// Configure which files the language server should handle
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'javascript' },
			{ scheme: 'file', language: 'typescript' }
		],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
		},
		errorHandler: {
			error: (error, message, count) => {
				outputChannel.appendLine(`LSP Error: ${error} ${message}`);
				return { action: ErrorAction.Continue };
			},
			closed: () => {
				outputChannel.appendLine('LSP Connection Closed.');
				return { action: CloseAction.Restart };
			}
		},
		outputChannel: outputChannel
	};

	// Create and start the language client
	client = new LanguageClient(
		'forgeLSP',
		'Forge Language Server',
		serverOptions,
		clientOptions
	);

	outputChannel.appendLine('Starting Forge Language Server...');
	await client.start();
	outputChannel.appendLine('Forge Language Server started.');
	vscode.workspace.createFileSystemWatcher('**/forgeconfig.json')
		.onDidChange(() => {
			if (client?.isRunning()) client.restart();
		});
}

/**
 * Extension deactivation cleanup.
 *
 * Stops the language server client gracefully when the extension is deactivated.
 *
 * @returns Promise that resolves when the client has stopped, or undefined if no client exists
 */
export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

// ============================================================================
// Platform & Binary Detection
// ============================================================================

/**
 * Determines the correct binary filename for the current platform and architecture.
 *
 * Supports:
 * - Linux: x86_64, aarch64
 * - macOS: x86_64, aarch64 (Apple Silicon)
 * - Windows: x86_64
 *
 * @returns The platform-specific binary filename, or null if unsupported
 */
function getServerBinaryName(): string | null {
	const platform = os.platform();
	const arch = os.arch();

	if (platform === 'linux') {
		if (arch === 'x64') return 'forgevsc-linux-x86_64';
		if (arch === 'arm64') return 'forgevsc-linux-aarch64';
	} else if (platform === 'darwin') {
		if (arch === 'x64') return 'forgevsc-macos-x86_64';
		if (arch === 'arm64') return 'forgevsc-macos-aarch64';
	} else if (platform === 'win32') {
		if (arch === 'x64') return 'forgevsc-windows-x86_64.exe';
	}

	return null;
}

// ============================================================================
// Update Checking & Metadata Management
// ============================================================================

/**
 * Fetches the latest release information from GitHub for a specific binary.
 *
 * Queries the GitHub API for the 'master' release tag and finds the matching
 * asset by name. Returns the asset's update timestamp and release tag.
 *
 * @param binaryName - The name of the binary asset to look for
 * @returns Object containing updated_at timestamp and tag_name, or null if not found/error
 */
async function getLatestReleaseInfo(binaryName: string): Promise<{ updated_at: string; tag_name: string } | null> {
	try {
		const response = await axios.get<GitHubRelease>('https://api.github.com/repos/zack-911/forgelsp/releases/tags/master');
		const asset = response.data.assets.find(a => a.name === binaryName);

		if (asset) {
			return {
				updated_at: asset.updated_at,
				tag_name: response.data.tag_name
			};
		}
		return null;
	} catch (error) {
		outputChannel.appendLine(`Failed to check for updates: ${error}`);
		return null;
	}
}

/**
 * Constructs the metadata file path for a given binary.
 *
 * Metadata files are stored alongside the binary with a .meta.json extension.
 *
 * @param binaryPath - Absolute path to the binary file
 * @returns Absolute path to the corresponding metadata file
 */
function getMetadataPath(binaryPath: string): string {
	return `${binaryPath}.meta.json`;
}

/**
 * Reads and parses the metadata file for a binary.
 *
 * @param binaryPath - Absolute path to the binary file
 * @returns Parsed metadata object, or null if file doesn't exist or parsing fails
 */
function readMetadata(binaryPath: string): BinaryMetadata | null {
	const metadataPath = getMetadataPath(binaryPath);
	if (!fs.existsSync(metadataPath)) {
		return null;
	}

	try {
		const content = fs.readFileSync(metadataPath, 'utf-8');
		return JSON.parse(content);
	} catch (error) {
		outputChannel.appendLine(`Failed to read metadata: ${error}`);
		return null;
	}
}

/**
 * Writes metadata to disk for a binary.
 *
 * Stores version information (updated_at timestamp and tag_name) alongside
 * the binary to enable update detection on future extension activations.
 *
 * @param binaryPath - Absolute path to the binary file
 * @param metadata - Metadata object to write
 */
function writeMetadata(binaryPath: string, metadata: BinaryMetadata): void {
	const metadataPath = getMetadataPath(binaryPath);
	try {
		fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
	} catch (error) {
		outputChannel.appendLine(`Failed to write metadata: ${error}`);
	}
}

/**
 * Determines if the local binary should be updated.
 *
 * Compares the local binary's metadata timestamp with the latest GitHub release.
 * Returns false if:
 * - No local metadata exists (fresh install, don't prompt)
 * - Unable to fetch remote release info
 * - Remote timestamp is not newer than local
 *
 * @param binaryPath - Absolute path to the local binary
 * @param binaryName - Name of the binary to check on GitHub
 * @returns true if an update is available, false otherwise
 */
async function shouldUpdate(binaryPath: string, binaryName: string): Promise<boolean> {
	const localMetadata = readMetadata(binaryPath);
	if (!localMetadata) {
		return false; // No metadata means fresh install, don't prompt
	}

	const remoteInfo = await getLatestReleaseInfo(binaryName);
	if (!remoteInfo) {
		return false; // Can't check, assume no update
	}

	// Compare update timestamps to determine if remote is newer
	const localDate = new Date(localMetadata.updated_at);
	const remoteDate = new Date(remoteInfo.updated_at);

	return remoteDate > localDate;
}

// ============================================================================
// Binary Download
// ============================================================================

/**
 * Downloads a language server binary from GitHub releases.
 *
 * Features:
 * - Streams the download to avoid loading entire file into memory
 * - Shows progress notification to the user
 * - Automatically saves metadata after successful download for update tracking
 * - Handles download errors gracefully
 *
 * @param filename - Name of the binary file to download
 * @param destPath - Absolute path where the binary should be saved
 * @returns Promise that resolves when download and metadata save complete
 */
async function downloadBinary(filename: string, destPath: string): Promise<void> {
	const url = `https://github.com/zack-911/forgelsp/releases/download/master/${filename}`;
	console.log(`Downloading Binary File To ${destPath}/${filename}`)
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Downloading ${filename}...`,
		cancellable: false
	}, async (progress) => {
		outputChannel.appendLine(`Downloading binary from ${url}`);
		const response = await axios({
			method: 'get',
			url: url,
			responseType: 'stream'
		});

		const writer = fs.createWriteStream(destPath);

		return new Promise<void>((resolve, reject) => {
			// Pipe the response stream directly to the file
			response.data.pipe(writer);
			let error: Error | null = null;
			writer.on('error', err => {
				error = err;
				writer.close();
				reject(err);
			});
			writer.on('close', async () => {
				if (!error) {
					outputChannel.appendLine('Download complete.');

					// Persist release metadata for future update checks
					const releaseInfo = await getLatestReleaseInfo(filename);
					if (releaseInfo) {
						writeMetadata(destPath, releaseInfo);
						outputChannel.appendLine('Metadata saved.');
					}

					resolve();
				}
			});
		});
	});
}
