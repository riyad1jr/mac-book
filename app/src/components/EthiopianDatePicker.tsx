import React, { useState } from 'react'
import { ETHIOPIAN_MONTHS, toEthiopianDate, parseStoredDate, ethiopianToIso, getEthiopianMonthDays } from '../utils/ethiopianCalendar'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'

interface EthiopianDatePickerProps {
  value?: string // YYYY-MM-DD (Gregorian)
  onChange: (gregorianIsoDate: string) => void
  label?: string
}

export function EthiopianDatePicker({ value, onChange, label = 'Select Date' }: EthiopianDatePickerProps) {
  const initialGc = value ? parseStoredDate(value) : new Date()
  const initialEth = toEthiopianDate(isNaN(initialGc.getTime()) ? new Date() : initialGc)

  const [ethYear, setEthYear] = useState(initialEth.year)
  const [ethMonth, setEthMonth] = useState(initialEth.month)
  const [isOpen, setIsOpen] = useState(false)

  // Convert selected Eth year, month, day back to Gregorian YYYY-MM-DD
  function handleSelectDay(day: number) {
    // Uses the calendar's checked conversion. The old code had its own
    // leap-year rule that put 2016 and 2017 E.C. one day off.
    const isoDate = ethiopianToIso(ethYear, ethMonth, day)
    onChange(isoDate)
    setIsOpen(false)
  }

  const selectedEth = toEthiopianDate(value ? parseStoredDate(value) : new Date())
  const maxDays = getEthiopianMonthDays(ethYear, ethMonth) // Pagume has 6 days in leap years

  return (
    <div className="ethiopian-datepicker-container" style={{ position: 'relative', display: 'inline-block' }}>
      {label && <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</label>}
      <button
        type="button"
        className="ethiopian-datepicker-trigger"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          background: 'var(--bg-panel, #ffffff)',
          border: '1px solid var(--border-color, #e2e8f0)',
          borderRadius: '8px',
          fontSize: '0.9rem',
          cursor: 'pointer',
          color: 'var(--text-color, #1e293b)'
        }}
      >
        <CalendarIcon size={16} style={{ color: '#0284c7' }} />
        <span>
          <b>{selectedEth.monthNameAm} {selectedEth.day}, {selectedEth.year} E.C.</b>
        </span>
      </button>

      {isOpen && (
        <div
          className="ethiopian-datepicker-modal"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 9999,
            marginTop: '6px',
            padding: '12px',
            background: 'var(--bg-panel, #ffffff)',
            border: '1px solid var(--border-color, #cbd5e1)',
            borderRadius: '12px',
            boxShadow: '0 12px 30px -5px rgba(0,0,0,0.25)',
            width: '290px',
            maxHeight: '340px',
            overflowY: 'auto'
          }}
        >
          {/* Header Controls */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button
              type="button"
              onClick={() => {
                if (ethMonth === 1) {
                  setEthMonth(13)
                  setEthYear(ethYear - 1)
                } else {
                  setEthMonth(ethMonth - 1)
                }
              }}
              style={{ background: 'var(--bg-hover, #f1f5f9)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '6px', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}
            >
              <ChevronLeft size={16} />
            </button>
            <span style={{ fontWeight: 700, fontSize: '0.88rem', textAlign: 'center', color: 'var(--text-color, #0f172a)' }}>
              {ETHIOPIAN_MONTHS[ethMonth - 1].nameAm} ({ETHIOPIAN_MONTHS[ethMonth - 1].nameEn}) {ethYear}
            </span>
            <button
              type="button"
              onClick={() => {
                if (ethMonth === 13) {
                  setEthMonth(1)
                  setEthYear(ethYear + 1)
                } else {
                  setEthMonth(ethMonth + 1)
                }
              }}
              style={{ background: 'var(--bg-hover, #f1f5f9)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '6px', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Days Grid (7 columns for standard calendar layout) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', textAlign: 'center' }}>
            {Array.from({ length: maxDays }, (_, i) => i + 1).map((d) => {
              const isSelected = selectedEth.year === ethYear && selectedEth.month === ethMonth && selectedEth.day === d
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => handleSelectDay(d)}
                  style={{
                    height: '30px',
                    lineHeight: '30px',
                    padding: 0,
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '0.8rem',
                    fontWeight: isSelected ? '700' : '500',
                    background: isSelected ? '#0284c7' : 'var(--bg-hover, #f1f5f9)',
                    color: isSelected ? '#ffffff' : 'var(--text-color, #334155)',
                    cursor: 'pointer'
                  }}
                >
                  {d}
                </button>
              )
            })}
          </div>
        </div>
      )}

    </div>
  )
}
