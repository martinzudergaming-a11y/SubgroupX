# oiia E2B sandbox template — authorized security-testing / CTF toolbox.
# Pre-installs the tooling agents commonly need so a sandbox spawns ready and can
# reach the network. Built via the E2B SDK (Template.build, API-key auth).
#
# IMPORTANT: E2B runs sandboxes as the non-root user `user`, and chmods
# /usr/local to 777. So everything below installs into /usr/local/bin, /opt, or a
# world-readable browsers dir — never /root (which `user` cannot read).
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    GOPATH=/opt/go \
    GOBIN=/usr/local/bin \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64 \
    PATH="/usr/local/go/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# --- base system + Java 8/11 + maven + python + common utils ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git unzip zip jq ripgrep build-essential pkg-config \
      openjdk-11-jdk openjdk-8-jdk maven \
      python3 python3-pip python3-venv \
      dnsutils whois net-tools iputils-ping nmap \
      vim less \
      lynx w3m w3m-img \
    && rm -rf /var/lib/apt/lists/* \
    && update-alternatives --set java /usr/lib/jvm/java-11-openjdk-amd64/bin/java

# --- env managers: mise (multi-runtime) + uv (python), installed to /usr/local/bin ---
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh && mise --version
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh && uv --version && uvx --version

# --- Go + the ProjectDiscovery recon suite (GOBIN=/usr/local/bin) ---
# Export PATH explicitly in the RUN so `go` resolves regardless of how the build
# shell treats the Dockerfile ENV.
RUN curl -fsSL https://go.dev/dl/go1.23.4.linux-amd64.tar.gz -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz \
    && export PATH="/usr/local/go/bin:$PATH" && go version
RUN export PATH="/usr/local/go/bin:$PATH" \
    && go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
    && go install -v github.com/projectdiscovery/dnsx/cmd/dnsx@latest \
    && go install -v github.com/projectdiscovery/httpx/cmd/httpx@latest \
    && go install -v github.com/projectdiscovery/naabu/v2/cmd/naabu@latest \
    && go install -v github.com/ffuf/ffuf/v2@latest \
    && go install -v github.com/OJ/gobuster/v3@latest \
    && go clean -cache
# amass (binary release) → /usr/local/bin (best-effort; glob-move avoids find -exec)
RUN (curl -fsSL https://github.com/owasp-amass/amass/releases/latest/download/amass_Linux_amd64.zip -o /tmp/amass.zip \
      && unzip -o /tmp/amass.zip -d /tmp/amass-x \
      && cp /tmp/amass-x/*/amass /usr/local/bin/amass \
      && chmod 0755 /usr/local/bin/amass \
      && rm -rf /tmp/amass.zip /tmp/amass-x) || echo "amass install skipped"
# SecLists wordlists (shallow clone)
RUN git clone --depth 1 https://github.com/danielmiessler/SecLists.git /opt/SecLists

# --- Java gadget-chain SOURCE (cloned + built; source kept under /opt) ---
RUN git clone --depth 1 https://github.com/frohoff/ysoserial.git /opt/ysoserial \
    && (cd /opt/ysoserial && mvn -q -DskipTests clean package || true)
RUN git clone --depth 1 https://github.com/mbechler/marshalsec.git /opt/marshalsec \
    && (cd /opt/marshalsec && mvn -q -DskipTests clean package || true)
RUN git clone --depth 1 https://github.com/wh1t3p1g/ysomap.git /opt/ysomap \
    && (cd /opt/ysomap && mvn -q -DskipTests clean package || true)

# --- web parsing / scraping: playwright (chromium, shared browsers dir) + monolith + trafilatura ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* \
    && npm i -g playwright @playwright/test \
    && mkdir -p /ms-playwright && npx --yes playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
# monolith: save a full web page as a single HTML file
RUN curl -fsSL https://github.com/Y2Z/monolith/releases/latest/download/monolith-gnu-linux-x86_64 -o /usr/local/bin/monolith \
    && chmod 0755 /usr/local/bin/monolith
# trafilatura: robust web text/HTML extraction CLI (system-wide → /usr/local/bin)
RUN pip3 install --no-cache-dir trafilatura

# --- WebAssembly analysis / reversing (CTF rev/pwn/crypto .wasm) ---
# Prebuilt release binaries (pinned) → /usr/local/bin; no source builds.
# wabt: wat2wasm, wasm2wat, wasm-objdump, wasm-decompile, wasm-validate,
#       wasm-interp, wasm2c, wasm-strip, etc.
RUN curl -fsSL https://github.com/WebAssembly/wabt/releases/download/1.0.41/wabt-1.0.41-linux-x64.tar.gz -o /tmp/wabt.tgz \
    && tar -C /tmp -xzf /tmp/wabt.tgz \
    && cp /tmp/wabt-1.0.41/bin/* /usr/local/bin/ \
    && rm -rf /tmp/wabt.tgz /tmp/wabt-1.0.41 \
    && wasm2wat --version
# binaryen: wasm-opt (+ wasm-dis, wasm-as, wasm-metadce, wasm-reduce, …)
RUN curl -fsSL https://github.com/WebAssembly/binaryen/releases/download/version_129/binaryen-version_129-x86_64-linux.tar.gz -o /tmp/binaryen.tgz \
    && tar -C /tmp -xzf /tmp/binaryen.tgz \
    && cp /tmp/binaryen-version_129/bin/* /usr/local/bin/ \
    && rm -rf /tmp/binaryen.tgz /tmp/binaryen-version_129 \
    && wasm-opt --version
# wasm-tools: validate/print/parse/demangle/component tooling (single binary)
RUN curl -fsSL https://github.com/bytecodealliance/wasm-tools/releases/download/v1.250.0/wasm-tools-1.250.0-x86_64-linux.tar.gz -o /tmp/wasm-tools.tgz \
    && tar -C /tmp -xzf /tmp/wasm-tools.tgz \
    && cp /tmp/wasm-tools-1.250.0-x86_64-linux/wasm-tools /usr/local/bin/ \
    && chmod 0755 /usr/local/bin/wasm-tools \
    && rm -rf /tmp/wasm-tools.tgz /tmp/wasm-tools-1.250.0-x86_64-linux \
    && wasm-tools --version
# wasmtime: primary .wasm runtime (single static binary)
RUN curl -fsSL https://github.com/bytecodealliance/wasmtime/releases/download/v45.0.0/wasmtime-v45.0.0-x86_64-linux.tar.xz -o /tmp/wasmtime.txz \
    && tar -C /tmp -xJf /tmp/wasmtime.txz \
    && cp /tmp/wasmtime-v45.0.0-x86_64-linux/wasmtime /usr/local/bin/ \
    && chmod 0755 /usr/local/bin/wasmtime \
    && rm -rf /tmp/wasmtime.txz /tmp/wasmtime-v45.0.0-x86_64-linux \
    && wasmtime --version
# wasmer: secondary runtime (broader Emscripten/WASIX compat); ships shared libs,
# so keep the tree under /opt and symlink the binary. Best-effort.
RUN (curl -fsSL https://github.com/wasmerio/wasmer/releases/download/v7.1.0/wasmer-linux-amd64.tar.gz -o /tmp/wasmer.tgz \
      && mkdir -p /opt/wasmer && tar -C /opt/wasmer -xzf /tmp/wasmer.tgz \
      && ln -sf /opt/wasmer/bin/wasmer /usr/local/bin/wasmer \
      && rm -f /tmp/wasmer.tgz \
      && wasmer --version) || echo "wasmer install skipped"
# twiggy: .wasm code-size profiler — no prebuilt binary, needs cargo. Install a
# minimal Rust toolchain under /opt/rust (world-readable) and build it.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
    && env RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo \
       sh /tmp/rustup.sh -y --profile minimal --no-modify-path \
    && rm -f /tmp/rustup.sh \
    && env RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo \
       /opt/rust/cargo/bin/cargo install twiggy --root /usr/local \
    && rm -rf /opt/rust/cargo/registry /opt/rust/cargo/git \
    && twiggy --version

# Make tool dirs world-readable/executable for the runtime `user`.
RUN chmod -R a+rX /usr/local/bin /opt/go /opt/wasmer 2>/dev/null || true
WORKDIR /home/user
