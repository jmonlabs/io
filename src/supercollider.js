/* jmon-to-supercollider.js - Convert jmon format to SuperCollider code */
// ...existing code...
export class Supercollider {
    static convert(composition) {
        const title = composition.metadata?.name || 'Untitled';
        let sc = `// SuperCollider script generated from JMON\n// Title: ${title}\n`;
        const notes = composition.tracks?.[0]?.notes || [];
        notes.forEach(note => {
            sc += `Synth(\"default\", [\"freq\", ${note.pitch}, \"dur\", ${note.duration}]);\n`;
        });
        return sc;
    }
}
export function supercollider(composition) {
    return Supercollider.convert(composition);
}
