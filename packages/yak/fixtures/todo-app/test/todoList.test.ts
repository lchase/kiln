import { describe, expect, it } from 'vitest'
import { addTodo, completeTodo, pendingTodos } from '../src/todoList.js'

describe('pendingTodos', () => {
  it('returns only todos that are not yet done', () => {
    let todos = addTodo([], 'buy milk')
    todos = addTodo(todos, 'walk dog')
    todos = completeTodo(todos, todos[0].id)

    const pending = pendingTodos(todos)

    expect(pending).toHaveLength(1)
    expect(pending[0].title).toBe('walk dog')
  })
})
