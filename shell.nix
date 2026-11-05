{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    pnpm_12
    rustc
    cargo
    rustfmt
    clippy
    gcc
    gnumake
    perl
    pkg-config
    postgresql_16
    podman
    podman-compose
    kubectl
    kubernetes-helm
  ];

  shellHook = ''
    export npm_config_manage_package_manager_versions="false"
    export DATABASE_URL="''${DATABASE_URL:-postgres://sell_guy:change-me@localhost:5432/sell_guy}"
    export API_HOST="''${API_HOST:-0.0.0.0}"
    export API_PORT="''${API_PORT:-8080}"
    echo "Sell Guy toolchain ready (Podman, Node, pnpm, Rust, PostgreSQL, kubectl, Helm)."
    echo "Use: pnpm install && pnpm dev"
  '';
}
