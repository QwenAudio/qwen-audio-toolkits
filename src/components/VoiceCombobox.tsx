import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { VoiceOption } from '../domain/voices'

interface VoiceComboboxProps {
  value: string
  options: VoiceOption[]
  placeholder: string
  onChange: (value: string) => void
  onCreate?: () => void
  onDelete?: (option: VoiceOption) => void
}

export function VoiceCombobox({
  value,
  options,
  placeholder,
  onChange,
  onCreate,
  onDelete,
}: VoiceComboboxProps) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const normalizedQuery = value.trim().toLocaleLowerCase()
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery || options.some((option) => option.id === value)) {
      return options
    }
    return options.filter((option) =>
      `${option.name} ${option.id} ${option.description}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    )
  }, [normalizedQuery, options, value])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  const select = (option: VoiceOption) => {
    onChange(option.id)
    setOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div
      className="voice-combobox"
      data-has-options={options.length > 0}
      ref={rootRef}
    >
      <input
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        value={value}
        placeholder={placeholder}
        spellCheck="false"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
          if (event.key === 'Enter' && open && filteredOptions[0]) {
            event.preventDefault()
            select(filteredOptions[0])
          }
          if (event.key === 'ArrowDown') setOpen(true)
        }}
      />
      {(options.length > 0 || onCreate) && (
        <button
          type="button"
          aria-label={open ? '收起音色列表' : '展开音色列表'}
          onClick={() => {
            setOpen((current) => !current)
            inputRef.current?.focus()
          }}
        >
          <ChevronDown size={14} />
        </button>
      )}
      {open && (options.length > 0 || onCreate) && (
        <div className="voice-combobox-menu" id={listId} role="listbox">
          {onCreate && (
            <button
              className="voice-combobox-create"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setOpen(false)
                onCreate()
              }}
            >
              <Plus size={14} />
              <span>
                <strong>新建音色</strong>
                <small>声音复刻或声音设计</small>
              </span>
            </button>
          )}
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <div
                className="voice-combobox-option"
                key={option.id}
                role="option"
                tabIndex={0}
                aria-selected={option.id === value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(option)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    select(option)
                  }
                }}
              >
                <span>
                  <strong>{option.name}</strong>
                  <small>{option.description}</small>
                </span>
                {!option.custom && <code>{option.id}</code>}
                <span className="voice-option-actions">
                  {option.id === value && <Check size={14} />}
                  {option.custom && onDelete && (
                    <button
                      className="voice-option-delete"
                      type="button"
                      title="删除音色"
                      aria-label={`删除音色 ${option.name}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete(option)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </span>
              </div>
            ))
          ) : (
            <p>未找到预置音色，可直接使用当前自定义 ID</p>
          )}
        </div>
      )}
    </div>
  )
}
