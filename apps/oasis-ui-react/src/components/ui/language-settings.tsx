/**
 * Language configuration panel — add/remove/reorder available languages.
 * Used inside the Settings > General tab.
 */
import { useState, useEffect } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  LanguageOption,
  getConfiguredLanguages,
  setConfiguredLanguages,
} from './language-selector';

export function LanguageSettings() {
  const [languages, setLanguages] = useState<LanguageOption[]>([]);
  const [newCode, setNewCode] = useState('');
  const [newLabel, setNewLabel] = useState('');

  useEffect(() => {
    setLanguages(getConfiguredLanguages());
  }, []);

  const save = (updated: LanguageOption[]) => {
    setLanguages(updated);
    setConfiguredLanguages(updated);
  };

  const handleAdd = () => {
    const code = newCode.trim().toLowerCase();
    const label = newLabel.trim();
    if (!code || !label) return;
    if (languages.some(l => l.code === code)) return; // duplicate
    save([...languages, { code, label }]);
    setNewCode('');
    setNewLabel('');
  };

  const handleRemove = (code: string) => {
    save(languages.filter(l => l.code !== code));
  };

  const handleMove = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= languages.length) return;
    const updated = [...languages];
    [updated[idx], updated[target]] = [updated[target], updated[idx]];
    save(updated);
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-slate-200">Available Languages</p>
        <p className="text-[10px] text-slate-500 mt-0.5">Configure which languages appear in the language selector across the app.</p>
      </div>

      {/* Existing languages */}
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {languages.map((lang, i) => (
          <div key={lang.code} className="flex items-center gap-2 group">
            <div className="flex flex-col gap-0.5">
              <button
                className="text-slate-600 hover:text-slate-400 disabled:opacity-20"
                disabled={i === 0}
                onClick={() => handleMove(i, -1)}
              >
                <GripVertical className="h-3 w-3 rotate-90 scale-x-[-1]" />
              </button>
              <button
                className="text-slate-600 hover:text-slate-400 disabled:opacity-20"
                disabled={i === languages.length - 1}
                onClick={() => handleMove(i, 1)}
              >
                <GripVertical className="h-3 w-3 rotate-90" />
              </button>
            </div>
            <span className="text-xs text-slate-400 w-8 font-mono">{lang.code}</span>
            <span className="text-xs text-slate-300 flex-1">{lang.label}</span>
            <button
              className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => handleRemove(lang.code)}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Add new language */}
      <div className="flex items-center gap-2">
        <Input
          className="text-xs h-7 w-16 bg-slate-950 border-slate-700"
          placeholder="Code"
          value={newCode}
          onChange={e => setNewCode(e.target.value)}
          maxLength={5}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
        />
        <Input
          className="text-xs h-7 flex-1 bg-slate-950 border-slate-700"
          placeholder="Label (e.g. Portuguese)"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
        />
        <Button variant="outline" size="sm" className="text-[10px] h-7 px-2" onClick={handleAdd} disabled={!newCode.trim() || !newLabel.trim()}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
