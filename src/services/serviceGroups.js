// Keep service rules inline so clients do not depend on a separate ruleset download.
export const serviceDomains = {
    ai: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'oaistatsig.com', 'anthropic.com', 'claude.ai', 'claudeusercontent.com', 'gemini.google.com', 'aistudio.google.com', 'generativelanguage.googleapis.com'],
    hyperliquid: ['hyperliquid.xyz', 'hyperliquid-testnet.xyz']
};
export function serviceRules(groups) {
    return groups.flatMap(group => (serviceDomains[group.service] || []).map(domain => `DOMAIN-SUFFIX,${domain},${group.name}`));
}
