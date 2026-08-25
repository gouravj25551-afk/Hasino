/* oxlint-disable react/only-export-components -- provider + useLang hook colocated by design. */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { dict, type TKey } from '@/lib/translations'

export type Lang = 'en' | 'hi'
const STORAGE_KEY = 'aahar.lang'

type Vars = Record<string, string | number>

interface LangCtx {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: TKey, vars?: Vars) => string
}

const Ctx = createContext<LangCtx | null>(null)

function initial(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'en' || v === 'hi') return v
  } catch {
    /* ignore */
  }
  return 'en'
}

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`))
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      /* ignore */
    }
    document.documentElement.lang = lang
  }, [lang])

  const t = (key: TKey, vars?: Vars): string => {
    const entry = dict[key]
    if (!entry) return key
    return interpolate(entry[lang], vars)
  }

  return <Ctx.Provider value={{ lang, setLang: setLangState, t }}>{children}</Ctx.Provider>
}

export function useLang(): LangCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useLang must be used inside <LangProvider>')
  return c
}
