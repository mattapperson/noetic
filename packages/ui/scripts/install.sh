#!/bin/bash
#
# Noetic UI Install Script
# Downloads and installs the appropriate binary for your platform
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mattapperson/noetic/main/packages/ui/scripts/install.sh | bash
#   # Or with specific version:
#   curl -fsSL ... | bash -s -- v0.1.0
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO="mattapperson/noetic"
BINARY_NAME="noetic-ui"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Parse arguments
VERSION="${1:-latest}"

# Detect platform
detect_platform() {
  local os
  local arch

  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    linux)
      os="linux"
      ;;
    darwin)
      os="darwin"
      ;;
    mingw*|msys*|cygwin*)
      os="windows"
      ;;
    *)
      echo -e "${RED}❌ Unsupported operating system: $os${NC}"
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64)
      arch="x64"
      ;;
    arm64|aarch64)
      arch="arm64"
      ;;
    *)
      echo -e "${RED}❌ Unsupported architecture: $arch${NC}"
      exit 1
      ;;
  esac

  if [ "$os" = "windows" ]; then
    echo "${BINARY_NAME}-windows-${arch}.exe"
  else
    echo "${BINARY_NAME}-${os}-${arch}"
  fi
}

# Get latest version from GitHub API
get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | \
    grep '"tag_name":' | \
    sed -E 's/.*"([^"]+)".*/\1/'
}

# Download binary
download_binary() {
  local version="$1"
  local filename="$2"
  local output_path="$3"

  local url="https://github.com/${REPO}/releases/download/${version}/${filename}"

  echo -e "${BLUE}📥 Downloading ${filename}...${NC}"
  echo -e "${BLUE}   URL: ${url}${NC}"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output_path"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$output_path"
  else
    echo -e "${RED}❌ Neither curl nor wget is installed${NC}"
    exit 1
  fi
}

# Main installation
main() {
  echo -e "${BLUE}🔮 Noetic UI Installer${NC}"
  echo ""

  # Detect platform
  local filename
  filename=$(detect_platform)
  echo -e "${BLUE}📦 Detected platform: ${filename}${NC}"

  # Determine version
  local version="$VERSION"
  if [ "$version" = "latest" ]; then
    echo -e "${BLUE}🔍 Looking up latest version...${NC}"
    version=$(get_latest_version)
    if [ -z "$version" ]; then
      echo -e "${RED}❌ Failed to determine latest version${NC}"
      exit 1
    fi
  fi

  echo -e "${BLUE}📋 Installing version: ${version}${NC}"
  echo ""

  # Create temp directory
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf $tmp_dir" EXIT

  local download_path="${tmp_dir}/${filename}"

  # Download
  if ! download_binary "$version" "$filename" "$download_path"; then
    echo -e "${RED}❌ Download failed${NC}"
    echo ""
    echo "Possible reasons:"
    echo "  - Version ${version} doesn't exist"
    echo "  - Your platform isn't supported yet"
    echo "  - GitHub API rate limit exceeded"
    echo ""
    echo "Check available releases at:"
    echo "  https://github.com/${REPO}/releases"
    exit 1
  fi

  # Make executable (Unix only)
  if [[ "$filename" != *.exe ]]; then
    chmod +x "$download_path"
  fi

  # Determine install location
  local install_path
  if [ "$filename" = "*.exe" ]; then
    install_path="${INSTALL_DIR}/${BINARY_NAME}.exe"
  else
    install_path="${INSTALL_DIR}/${BINARY_NAME}"
  fi

  # Check if we need sudo
  local use_sudo=false
  if [ -d "$INSTALL_DIR" ]; then
    if [ ! -w "$INSTALL_DIR" ]; then
      use_sudo=true
    fi
  else
    # Try to create the directory
    if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
      use_sudo=true
    fi
  fi

  # Install
  echo -e "${BLUE}📂 Installing to: ${install_path}${NC}"
  if [ "$use_sudo" = true ]; then
    echo -e "${YELLOW}⚠️  Sudo required to write to ${INSTALL_DIR}${NC}"
    sudo mkdir -p "$INSTALL_DIR"
    sudo mv "$download_path" "$install_path"
  else
    mkdir -p "$INSTALL_DIR"
    mv "$download_path" "$install_path"
  fi

  # Verify
  if [ -f "$install_path" ]; then
    echo ""
    echo -e "${GREEN}✅ Noetic UI installed successfully!${NC}"
    echo ""
    echo -e "${BLUE}Usage:${NC}"
    echo "  ${BINARY_NAME} serve              # Start the server"
    echo "  ${BINARY_NAME} --help             # Show help"
    echo ""
    echo -e "${BLUE}Environment variables:${NC}"
    echo "  NOETIC_UI_WS_PORT=3333           # WebSocket port"
    echo "  NOETIC_UI_API_PORT=3334          # API/Web UI port"
    echo "  NOETIC_UI_HOST=127.0.0.1         # Bind address"
    echo ""
    echo -e "${BLUE}Quick start:${NC}"
    echo "  ${BINARY_NAME} serve"
    echo ""
    echo "Then open: http://localhost:3334"
    echo ""

    # Check if install dir is in PATH
    if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
      echo -e "${YELLOW}⚠️  Warning: ${INSTALL_DIR} is not in your PATH${NC}"
      echo "Add this to your shell profile:"
      echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
      echo ""
    fi
  else
    echo -e "${RED}❌ Installation failed${NC}"
    exit 1
  fi
}

# Run main function
main "$@"
