import { useState } from 'react'
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import type { TodoModel } from 'example-todo-sync/schema'
import { theme } from '../theme'

type Props = {
  todo: TodoModel
  onToggle: () => void
  onDelete: () => void
  onEdit: (text: string) => void
}

export function TodoItem({ todo, onToggle, onDelete, onEdit }: Props) {
  const [draft, setDraft] = useState<string | null>(null)

  const commitEdit = () => {
    const trimmed = draft?.trim()
    setDraft(null)
    if (trimmed && trimmed !== todo.text) onEdit(trimmed)
  }

  const confirmDelete = () => {
    Alert.alert(
      `Are you sure you want to delete ${todo.text}?`,
      'It will be gone for good',
      [
        { text: 'Yes', onPress: onDelete, style: 'destructive' },
        { text: 'Cancel', style: 'cancel' },
      ],
    )
  }

  return (
    <View style={styles.itemContainer}>
      {draft === null ? (
        <Pressable
          style={styles.text}
          onPress={onToggle}
          onLongPress={() => setDraft(todo.text)}
        >
          <Text style={[styles.itemText, todo.done && styles.done]}>
            {todo.text}
          </Text>
        </Pressable>
      ) : (
        <TextInput
          style={[styles.text, styles.editInput]}
          value={draft}
          onChangeText={setDraft}
          autoFocus
          onSubmitEditing={commitEdit}
          onBlur={() => setDraft(null)}
        />
      )}
      {draft === null && (
        <TouchableOpacity
          onPress={() => setDraft(todo.text)}
          style={styles.button}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>Edit</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={confirmDelete}
        style={styles.button}
        activeOpacity={0.8}
      >
        <Text style={styles.buttonText}>Delete</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  itemContainer: {
    paddingVertical: 16,
    paddingHorizontal: 8,
    gap: 8,
    // borderColor, not borderBottomColor: per-side border colors render black on Android in RN 0.86
    borderColor: theme.colorCerulean,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  text: { flex: 1 },
  itemText: { fontSize: 18, fontWeight: '200' },
  editInput: {
    fontSize: 18,
    fontWeight: '200',
    borderWidth: 1,
    borderColor: theme.colorCerulean,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  done: { textDecorationLine: 'line-through', color: theme.colorGrey },
  button: {
    backgroundColor: theme.colorBlack,
    padding: 8,
    borderRadius: 6,
  },
  buttonText: {
    color: theme.colorWhite,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
})
