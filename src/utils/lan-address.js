const os = require('os');

/*
 * Adresses IPv4 du serveur sur le réseau local, relues à chaque appel :
 * elles suivent automatiquement les changements de Wi-Fi.
 * Les cartes virtuelles (WSL, Docker, Hyper-V, VPN…) sont écartées.
 */

const VIRTUAL_INTERFACE = /vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier|Hamachi|TAP|TUN|utun|vboxnet|br-|veth/i;

function interfaceRank(name) {
  if (/wi-?fi|wlan|wireless|wlp|en0/i.test(name)) return 0;
  if (/ethernet|eth|enp|eno/i.test(name)) return 1;
  return 2;
}

function getLanAddresses() {
  const candidates = [];

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const address of addresses || []) {
      const isIpv4 = address.family === 'IPv4' || address.family === 4;
      if (!isIpv4 || address.internal || address.address.startsWith('169.254.')) continue;
      candidates.push({ interface: name, address: address.address });
    }
  }

  return candidates.sort((a, b) => interfaceRank(a.interface) - interfaceRank(b.interface));
}

module.exports = { getLanAddresses };
