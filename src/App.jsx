import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import './App.css'

const DATA_URL =
  'http://docs.google.com/spreadsheets/d/1MYw7EtNBTk13LGtnEiOHUAqXnbd6h6ucjR7B-FBBhBY/export?format=csv&gid=224609678'
const REVIEWED_STORAGE_KEY = 'application-reviewer:reviewed:v1'

function toStorageSet() {
  try {
    const raw = localStorage.getItem(REVIEWED_STORAGE_KEY)
    if (!raw) {
      return new Set()
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return new Set()
    }
    return new Set(parsed)
  } catch {
    return new Set()
  }
}

function toDisplayName(row) {
  const fallbackFields = ['Character Name', 'Name', 'Full Name', 'Discord']
  for (const field of fallbackFields) {
    const value = String(row[field] ?? '').trim()
    if (value) {
      return value
    }
  }
  return 'Unnamed applicant'
}

function makeApplicationId(row, index) {
  const stableParts = [
    row['Timestamp'],
    row['Character Name'],
    row['Discord'],
    row['Reviewed'],
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('|')

  return stableParts ? stableParts : `row-${index}`
}

const URL_PATTERN = /(https?:\/\/[^\s,")]+)/g

function hasReviewedValue(value) {
  return String(value ?? '').trim() !== ''
}

function isUrlToken(value) {
  return /^https?:\/\/[^\s,")]+$/i.test(value)
}

function renderTextWithLinks(value) {
  const text = String(value ?? '')
  const parts = text.split(URL_PATTERN)

  return parts.map((part, index) => {
    if (isUrlToken(part)) {
      return (
        <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer">
          {part}
        </a>
      )
    }

    return <span key={`text-${index}`}>{part}</span>
  })
}

function toTimestampMs(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return 0
  }

  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? 0 : parsed
}

function matchesSearch(application, query) {
  if (!query) {
    return true
  }

  const haystack = [
    application._displayName,
    application['Character Name'],
    application.Discord,
    application['Main Class/Spec (include offspecs if comfortable)'],
    application.Timestamp,
  ]
    .map((item) => String(item ?? '').toLowerCase())
    .join(' ')

  return haystack.includes(query)
}

const COMPACT_FIELDS = new Set([
  'Timestamp',
  'Age',
  'Character Name',
  'Main Class/Spec (include offspecs if comfortable)',
  "If you've played several classes, list them here",
  'Discord',
])

function App() {
  const [applications, setApplications] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [reviewedIds, setReviewedIds] = useState(() => toStorageSet())
  const [sheetReviewedIds, setSheetReviewedIds] = useState(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [reviewFilter, setReviewFilter] = useState('hide-reviewed')
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    let isMounted = true

    async function loadApplications() {
      try {
        setIsLoading(true)
        setErrorMessage('')

        const response = await fetch(DATA_URL)
        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`)
        }

        const csvText = await response.text()
        const parsed = Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
        })

        if (parsed.errors.length > 0) {
          throw new Error(parsed.errors[0].message)
        }

        const rows = parsed.data
          .map((row, index) => {
            const id = makeApplicationId(row, index)
            return {
              ...row,
              _id: id,
              _displayName: toDisplayName(row),
              _timestampMs: toTimestampMs(row.Timestamp),
            }
          })
          .filter((row) => {
            const hasAnyValue = Object.entries(row).some(([key, value]) => {
              if (key.startsWith('_')) {
                return false
              }
              return String(value ?? '').trim() !== ''
            })
            return hasAnyValue
          })

        if (!isMounted) {
          return
        }

        const nextSheetReviewedIds = new Set(
          rows
            .filter((row) => hasReviewedValue(row.Reviewed))
            .map((row) => row._id),
        )

        setSheetReviewedIds(nextSheetReviewedIds)
        setReviewedIds((current) => {
          const next = new Set(current)
          nextSheetReviewedIds.forEach((id) => next.add(id))
          return next
        })
        setApplications(rows)
      } catch (error) {
        if (!isMounted) {
          return
        }
        setErrorMessage(error instanceof Error ? error.message : 'Unknown error')
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    loadApplications()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(
      REVIEWED_STORAGE_KEY,
      JSON.stringify(Array.from(reviewedIds)),
    )
  }, [reviewedIds])

  const sortedApplications = useMemo(() => {
    const next = [...applications]
    next.sort((a, b) => b._timestampMs - a._timestampMs)
    return next
  }, [applications])

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()

  const effectiveReviewedIds = useMemo(() => {
    const next = new Set(reviewedIds)
    sheetReviewedIds.forEach((id) => next.add(id))
    return next
  }, [reviewedIds, sheetReviewedIds])

  const visibleApplications = useMemo(() => {
    return sortedApplications.filter((application) => {
      const isReviewed = effectiveReviewedIds.has(application._id)

      if (reviewFilter === 'hide-reviewed' && isReviewed) {
        return false
      }

      if (reviewFilter === 'only-reviewed' && !isReviewed) {
        return false
      }

      return matchesSearch(application, normalizedSearchQuery)
    })
  }, [sortedApplications, effectiveReviewedIds, reviewFilter, normalizedSearchQuery])

  const pendingCount = useMemo(
    () =>
      applications.filter((application) => !effectiveReviewedIds.has(application._id))
        .length,
    [applications, effectiveReviewedIds],
  )

  useEffect(() => {
    if (visibleApplications.length === 0) {
      setSelectedId('')
      return
    }

    const selectionStillVisible = visibleApplications.some(
      (application) => application._id === selectedId,
    )

    if (!selectionStillVisible) {
      setSelectedId(visibleApplications[0]._id)
    }
  }, [visibleApplications, selectedId])

  const selectedApplication = visibleApplications.find(
    (application) => application._id === selectedId,
  )

  const isSelectedReviewed =
    selectedApplication !== undefined &&
    effectiveReviewedIds.has(selectedApplication._id)

  function markSelectedAsReviewed() {
    if (!selectedApplication) {
      return
    }
    setReviewedIds((current) => {
      const next = new Set(current)
      next.add(selectedApplication._id)
      return next
    })
  }

  function markSelectedAsUnreviewed() {
    if (!selectedApplication) {
      return
    }
    setReviewedIds((current) => {
      const next = new Set(current)
      next.delete(selectedApplication._id)
      return next
    })
  }

  function markBeforeSelectedAsReviewed() {
    if (!selectedApplication) {
      return
    }

    const selectedIndex = visibleApplications.findIndex(
      (application) => application._id === selectedApplication._id,
    )

    if (selectedIndex <= 0) {
      return
    }

    const idsBeforeSelection = visibleApplications
      .slice(0, selectedIndex)
      .map((application) => application._id)

    setReviewedIds((current) => {
      const next = new Set(current)
      idsBeforeSelection.forEach((id) => next.add(id))
      return next
    })
  }

  const statsLabel = `${pendingCount} pending / ${applications.length} total`
  const listStatsLabel = `${visibleApplications.length} shown`

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <p className="eyebrow">Applications</p>
          <h1>Review Queue</h1>
          <p className="stats">{statsLabel}</p>
        </div>

        <div className="sidebar-controls">
          <input
            type="search"
            className="search-input"
            placeholder="Search applications"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />

          <select
            className="filter-select"
            value={reviewFilter}
            onChange={(event) => setReviewFilter(event.target.value)}
            aria-label="Reviewed application visibility"
          >
            <option value="hide-reviewed">Hide reviewed</option>
            <option value="show-all">Show all</option>
            <option value="only-reviewed">Only reviewed</option>
          </select>

          <p className="stats">{listStatsLabel}</p>
        </div>

        <div className="sidebar-list" role="listbox" aria-label="Application list">
          {isLoading && <p className="muted">Loading applications...</p>}

          {!isLoading && errorMessage && (
            <p className="error">Could not load data: {errorMessage}</p>
          )}

          {!isLoading && !errorMessage && visibleApplications.length === 0 && (
            <p className="muted">No applications match the current filters.</p>
          )}

          {!isLoading &&
            !errorMessage &&
            visibleApplications.map((application) => {
              const isSelected = application._id === selectedId
              const isReviewed = effectiveReviewedIds.has(application._id)
              const chipClassName = `app-chip ${isSelected ? 'selected' : ''} ${
                isReviewed ? 'reviewed' : ''
              }`
              return (
                <button
                  key={application._id}
                  type="button"
                  className={chipClassName}
                  onClick={() => setSelectedId(application._id)}
                >
                  <span className="name">{application._displayName}</span>
                  <span className="timestamp">{application.Timestamp || 'No timestamp'}</span>
                </button>
              )
            })}
        </div>

      </aside>

      <main className="detail-panel">
        {!selectedApplication && !isLoading && !errorMessage && (
          <section className="empty-state">
            <h2>All caught up</h2>
            <p>Every application is currently marked as reviewed.</p>
          </section>
        )}

        {selectedApplication && (
          <section className="detail-card" aria-live="polite">
            <div className="detail-header">
              <div>
                <p className="eyebrow">Selected Applicant</p>
                <h2>{selectedApplication._displayName}</h2>
              </div>
              <div className="detail-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={markBeforeSelectedAsReviewed}
                >
                  Mark all before as reviewed
                </button>
                <button
                  type="button"
                  className="review-action"
                  onClick={isSelectedReviewed ? markSelectedAsUnreviewed : markSelectedAsReviewed}
                >
                  {isSelectedReviewed ? 'Mark as unreviewed' : 'Mark as reviewed'}
                </button>
              </div>
            </div>

            <div className="fields-grid">
              {Object.entries(selectedApplication)
                .filter(([key, value]) => {
                  if (key.startsWith('_')) {
                    return false
                  }
                  if (key === 'Reviewed') {
                    return false
                  }
                  return String(value ?? '').trim() !== ''
                })
                .map(([key, value]) => {
                  const stringValue = String(value)
                  const isCompactField = COMPACT_FIELDS.has(key)
                  const renderedValue = renderTextWithLinks(stringValue)

                  return (
                    <article
                      key={key}
                      className={`field-item ${
                        isCompactField ? 'field-item-compact' : 'field-item-full'
                      }`}
                    >
                      <label>{key}</label>
                      <div
                        className={`field-value ${
                          isCompactField ? 'field-value-compact' : 'field-value-full'
                        }`}
                      >
                        {renderedValue}
                      </div>
                    </article>
                  )
                })}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
