import { HELP_SECTIONS } from '../lib/shortcuts'
import { Modal } from './ui'

export function ShortcutsHelp({ onClose }: { onClose(): void }): React.JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcuts-help">
        {HELP_SECTIONS.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            <dl>
              {section.items.map((item) => (
                <div key={item.keys} className="shortcut-row">
                  <dt>
                    {item.keys.split(/(?<=.)\+/).map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{item.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="muted">Most shortcuts are ignored while you type in a text field.</p>
      </div>
      <div className="modal-actions">
        <button className="btn primary" autoFocus onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
