# ForgeLSP VS Code Extension

<div align="center">

![VS Code](https://img.shields.io/badge/VS%20Code-1.75.0+-blue?style=for-the-badge&logo=visual-studio-code)
![TypeScript](https://img.shields.io/badge/TypeScript-5.1-3178C6?style=for-the-badge&logo=typescript)
![GitHub License](https://img.shields.io/github/license/Zack-911/forgevsc)

**A powerful VS Code extension for ForgeScript development with intelligent code assistance**

</div>

---

## ✨ Features

### 🚀 Automatic Binary Management
- **Cross-platform support**: Linux (x86_64, aarch64), macOS (x86_64, Apple Silicon), Windows (x86_64)
- **Auto-download**: Automatically downloads the correct LSP binary for your platform on first run
- **Auto-updates**: Detects and prompts for new LSP versions from GitHub releases
- **Version tracking**: Maintains metadata files to track installed binary versions

### 📝 Workspace Configuration
- **forgeconfig.json**: Central configuration file for your ForgeScript project
- **Create Config Command**: Generate a new configuration file with a single command
- **Auto-activation**: Extension activates automatically when `forgeconfig.json` is present

### 🔧 Language Server Features

#### Hover Information
- Rich markdown documentation for ForgeScript functions
- Displays function signatures with argument types
- Shows examples from function metadata
- Indicates optional/required parameters

#### Intelligent Completions
- Context-aware function suggestions triggered by `$`
- Category-based function grouping
- Detailed documentation in completion items

#### Signature Help
- Real-time parameter hints while typing
- Active parameter highlighting
- Support for nested function calls
- Handles complex bracket/semicolon syntax

#### Semantic Highlighting
- Syntax highlighting for functions, strings, numbers, booleans
- Works within code blocks in string templates
- Consistent visual distinction for ForgeScript syntax

#### Diagnostics
- Real-time error detection
- Unknown function warnings
- Argument count validation
- Bracket matching errors

---

## 🛠️ Installation

1. Install from the VS Code marketplace (or build from source)
2. Open a project with a `forgeconfig.json` file, or create one:
   - Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Run: **Create Forge Config**
3. The extension will prompt to download the LSP binary

---

## 📋 Commands

| Command | Description |
|---------|-------------|
| `Create Forge Config` | Creates a `forgeconfig.json` in the workspace root |
| `Update ForgeLSP Binary` | Manually check for and install LSP updates |

---

## ⚙️ Configuration

### forgeconfig.json

```json
{
  "$schema": "vscode://schemas/forgeconfig",
  "urls": [
    "github:tryforge/forgescript" // Branch can be specified by using # such as github:tryforge/forgescript#dev
  ]
}
```

### Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `forgevsc.trace.server` | `string` | `"off"` | Traces communication between VS Code and the language server (`off`, `messages`, `verbose`) |

---

## 🏗️ Architecture

```
forgevsc/
├── src/
│   └── extension.ts    # Main extension entry point
├── syntaxes/
│   ├── forge.tmLanguage.json    # ForgeScript syntax grammar
│   └── injection.json           # JS/TS injection grammar
├── schema.json                  # forgeconfig.json schema
└── package.json                 # Extension manifest
```

### Key Components

- **Binary Detection**: Platform-specific binary selection based on OS and architecture
- **Metadata Management**: Stores version info alongside binaries for update detection
- **Error Handling**: Graceful degradation with comprehensive error recovery
- **Progress Notifications**: User-friendly download progress indicators

---

## 📊 Supported Platforms

| Platform | Architecture | Binary Name |
|----------|--------------|-------------|
| Linux | x86_64 | `forgevsc-linux-x86_64` |
| Linux | ARM64 | `forgevsc-linux-aarch64` |
| macOS | x86_64 | `forgevsc-macos-x86_64` |
| macOS | Apple Silicon | `forgevsc-macos-aarch64` |
| Windows | x86_64 | `forgevsc-windows-x86_64.exe` |

---

## 🔗 Related Projects

- **[ForgeLSP](../forgelsp)** - The Rust-based Language Server Protocol implementation
- **[ForgeScript](https://github.com/tryforge/forgescript)** - The ForgeScript language

---

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.
