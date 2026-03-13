#!/usr/bin/env bash
set -e

echo "=== Worktree Spawn Util — First-Time Setup ==="
echo ""

# 1. Check for Node.js
if command -v node &>/dev/null; then
    echo "Node.js found: $(node --version)"
else
    echo "Node.js is not installed."

    # Check for Homebrew
    if ! command -v brew &>/dev/null; then
        read -rp "Homebrew is not installed. Install it now? (y/n) " install_brew
        if [[ "$install_brew" =~ ^[Yy]$ ]]; then
            echo "Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        else
            echo "Please install Node.js manually: https://nodejs.org"
            exit 1
        fi
    fi

    read -rp "Install Node.js via Homebrew? (y/n) " install_node
    if [[ "$install_node" =~ ^[Yy]$ ]]; then
        echo "Installing Node.js..."
        brew install node
    else
        echo "Please install Node.js manually: https://nodejs.org"
        exit 1
    fi
fi

# 2. Install npm dependencies
echo ""
echo "Running npm install..."
npm install

# 3. Success
echo ""
echo "Setup complete! You can now use the VS Code tasks."
