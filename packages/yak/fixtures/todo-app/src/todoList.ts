export interface Todo {
  id: string
  title: string
  done: boolean
}

export function addTodo(todos: Todo[], title: string): Todo[] {
  return [...todos, { id: crypto.randomUUID(), title, done: false }]
}

export function completeTodo(todos: Todo[], id: string): Todo[] {
  return todos.map((t) => (t.id === id ? { ...t, done: true } : t))
}

export function pendingTodos(todos: Todo[]): Todo[] {
  return todos.filter((t) => t.done)
}
