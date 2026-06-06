{
  description = "opencode-m365 dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # pi's published npm-shrinkwrap.json omits integrity for its own
        # first-party sub-packages, which makes buildNpmPackage's prefetch
        # panic. Inject the registry integrity hashes before the lockfile is read.
        fixPiLock = pkgs.writeText "fix-pi-lock.js" ''
          const fs = require("fs");
          // 1) pi's shrinkwrap omits integrity for its own sub-packages — add them.
          const lf = "npm-shrinkwrap.json";
          const j = JSON.parse(fs.readFileSync(lf, "utf8"));
          const I = {
            "node_modules/@earendil-works/pi-agent-core": "sha512-oPwVRkkAvyKPWyM7E4k+EaTNmynbYn7ZLG/LBh9BUnMNb2gvpMp+VQ420R6JCJ20uogSqrHnWTyosSa/rU8lVw==",
            "node_modules/@earendil-works/pi-ai": "sha512-CM2pkTs1iupG/maw381lC9Q/Y/aQaMGK7GILc28ttImD0ci3LDwKroDsGkWbly5JIy3iqxdRxB9JlG7vvzCzTg==",
            "node_modules/@earendil-works/pi-tui": "sha512-07GVQo/38a0yvIPlWDr3RJn1B8gk3ZuIX9h2oIQ+Biyu3JN0KppWmgWHfaWRydQgse5JtC++KDw5MWaIRnV0mw=="
          };
          for (const [k, v] of Object.entries(I)) {
            if (j.packages && j.packages[k]) j.packages[k].integrity = v;
          }
          fs.writeFileSync(lf, JSON.stringify(j, null, 2));
          // 2) The shrinkwrap omits the dev-dependency tree, so `npm ci` would try
          // to resolve devDependencies (e.g. @types/*) that aren't in the cache.
          // dist/ is prebuilt, so drop devDependencies entirely to keep ci offline.
          const pf = "package.json";
          const p = JSON.parse(fs.readFileSync(pf, "utf8"));
          delete p.devDependencies;
          fs.writeFileSync(pf, JSON.stringify(p, null, 2));
        '';

        # pi coding agent (https://pi.dev) — a minimal agent harness, packaged
        # from its npm release so it travels with the flake across machines.
        pi = pkgs.buildNpmPackage rec {
          pname = "pi-coding-agent";
          version = "0.78.1";
          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${version}.tgz";
            hash = "sha256-72mCHDg9kv0n59mtvcseN2IUQelMUjSOR6KQHqnX3Qw=";
          };
          sourceRoot = "package";
          postPatch = "${pkgs.nodejs}/bin/node ${fixPiLock}";
          # dist/ is prebuilt in the tarball; just install prod deps + the bin
          # wrapper. Dev deps (e.g. @types/*) aren't in the prefetched cache.
          dontNpmBuild = true;
          npmFlags = [ "--ignore-scripts" ];
          npmInstallFlags = [ "--omit=dev" ];
          npmDepsHash = "sha256-ZR1dJcf5fAMK+7jtT0aDwNYYRaS0Pye1fLkUxVHtO+Y=";
        };
      in
      {
        packages.pi = pi;

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            pnpm
            chromium
            pi
          ];

          shellHook = ''
            export CHROMIUM_PATH="${pkgs.chromium}/bin/chromium"
          '';
        };
      }
    );
}
